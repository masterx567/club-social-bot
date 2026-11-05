import sharp from "sharp";
import { redis } from "./store";

// Ricerca automatica dei loghi online (2026-10-29): quando manca il logo di una squadra, prima di chiederlo
// il bot cerca immagini (Brave Search API, BRAVE_API_KEY) e fa controllare a Groq vision che siano davvero il logo
// di quella squadra. Il primo candidato buono va nel gruppo con ✅ Usa questo / 🔄 Un altro: decide sempre una persona.
// Senza chiave, o senza candidati buoni, resta la domanda di sempre.

const MODELLO = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const MAX_CONTROLLI = 6; // immagini controllate da Groq per squadra (piano gratuito)
// Tempo massimo di una ricerca (29/10: con le attese per i 429 la funzione superava il limite di Vercel e moriva
// senza mandare nulla, né il logo né la domanda). Finito il tempo si fa la domanda normale.
const TEMPO_MS = 40_000;

// Parole del nome utili a riconoscere l'URL giusto (TUMMINELLI ROMANA BASKET -> tumminelli, romana)
const parole = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !["basket", "basketball", "pallacanestro", "promozio", "sport"].includes(w));
// Prima le immagini con il nome della squadra nell'indirizzo: meno controlli AI per trovare quella giusta
function ordina(urls: string[], nome: string, nomeLungo?: string) {
  const p = [...new Set([...parole(nome), ...parole(nomeLungo || "")])];
  const punti = (u: string) => p.filter((w) => u.toLowerCase().includes(w)).length;
  return urls.map((u, i) => ({ u, i, k: punti(u) })).sort((a, b) => b.k - a.k || a.i - b.i).map((x) => x.u);
}
const TTL = 3 * 86_400;
// chiave = chat per le domande dei caroselli; i loghi del torneo usano una chiave loro (non si pestano i piedi)
const kCand = (chiave: number | string) => `logocand:${chiave}`;

export interface Candidati {
  nome: string; // nome in grafica (chiave dei loghi)
  urls: string[]; // immagini trovate, nell'ordine della ricerca
  i: number; // prossima da controllare
}

export const ricercaAttiva = () => !!process.env.BRAVE_API_KEY && !!process.env.GROQ_API_KEY;

async function cerca(query: string): Promise<string[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/images/search?${new URLSearchParams({ q: query, count: "20", safesearch: "strict", country: "it" })}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Brave ${r.status}`);
  const j = await r.json();
  return ((j.results || []) as any[]).map((x) => x.properties?.url || x.thumbnail?.src).filter((u): u is string => typeof u === "string" && /^https?:/.test(u));
}

async function scarica(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 ClubSocialBot" } });
    if (!r.ok || !/^image\//.test(r.headers.get("content-type") || "")) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 1500 || b.length > 8_000_000) return null;
    const m = await sharp(b).metadata();
    if (!m.width || !m.height || m.width < 80 || m.height < 80) return null;
    return b;
  } catch {
    return null;
  }
}

// Groq: è il logo (stemma) di questa squadra? Nel dubbio no.
export async function eLogoDi(img: Buffer, nome: string, nomeLungo?: string): Promise<boolean> {
  const v = await classificaLogo(img, nome, nomeLungo);
  return v.tipo === "logo" && v.squadra === true;
}

export async function classificaLogo(img: Buffer, nome: string, nomeLungo?: string, scadenza = Infinity): Promise<{ tipo?: string; testo?: string; squadra?: boolean }> {
  const piccola = await sharp(img).flatten({ background: "#ffffff" }).resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  // 2026-10-29: con la domanda sì/no il modello diceva "logo" anche a foto di squadra e volantini. Ora classifica
  // e decide il codice: solo tipo "logo" con il testo letto che richiama la squadra.
  const prompt = `Classifica questa immagine.
tipo: "logo" solo se è uno stemma o marchio grafico isolato (simbolo e/o scritta, fondo semplice). Una foto con persone è "foto", un manifesto o volantino con testo lungo è "volantino", altrimenti "altro".
testo: le parole leggibili nel logo, in maiuscolo ("" se nessuna).
squadra: true solo se il logo appartiene alla squadra sportiva "${nomeLungo || nome}" (il testo contiene il suo nome o una sua sigla). Un logo di federazione (FIP, CSI, UISP) o di sponsor è false.
Rispondi solo JSON: {"tipo": "...", "testo": "...", "squadra": true|false}`;
  const corpo = JSON.stringify({
      model: MODELLO,
      temperature: 0,
      max_completion_tokens: 80,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${piccola.toString("base64")}` } }] }],
  });
  // Piano gratuito Groq: con più immagini di fila arriva 429. Si aspetta quanto chiede (retry-after) e si riprova,
  // fino a 4 tentativi (prova del 29/10: dalla terza immagine in poi tutte 429)
  for (let tentativo = 0; ; tentativo++) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: corpo,
    });
    if (r.status === 429 && tentativo < 3) {
      const attesa = Math.min(30, Math.max(3, Number(r.headers.get("retry-after")) || 10));
      if (Date.now() + attesa * 1000 > scadenza) throw new Error("Groq 429, tempo finito");
      await new Promise((ok) => setTimeout(ok, attesa * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const j = await r.json();
    return JSON.parse(j.choices[0].message.content);
  }
}

// Prossimo candidato buono per la domanda aperta in chat. Prima chiamata (nuovo nome): fa la ricerca.
// sport (torneo, 2026-11-01): la ricerca usa lo sport della squadra al posto di "basket"
export async function prossimoLogo(chat: number | string, nome: string, nomeLungo?: string, sport?: string): Promise<{ img: Buffer; url: string } | null> {
  if (!ricercaAttiva()) return null;
  const scadenza = Date.now() + TEMPO_MS;
  let c = await redis.get<Candidati>(kCand(chat));
  if (!c || c.nome !== nome) {
    const query = `${nomeLungo || nome} ${sport ? sport.toLowerCase() : "basket"} logo`;
    let urls: string[] = [];
    try {
      urls = await cerca(query);
    } catch (e) {
      console.error("cerca logo", e);
      return null;
    }
    c = { nome, urls: ordina([...new Set(urls)], nome, nomeLungo), i: 0 };
    await redis.set(kCand(chat), c, { ex: TTL });
  }
  let controllati = 0;
  while (c.i < c.urls.length && controllati < MAX_CONTROLLI && Date.now() < scadenza) {
    const url = c.urls[c.i++];
    const img = await scarica(url);
    if (!img) continue;
    controllati++;
    const v = await classificaLogo(img, nome, nomeLungo, scadenza).catch(() => null);
    const ok = v?.tipo === "logo" && v.squadra === true;
    if (ok) {
      await redis.set(kCand(chat), c, { ex: TTL });
      await redis.set(`${kCand(chat)}:ora`, url, { ex: TTL });
      return { img, url };
    }
  }
  await redis.set(kCand(chat), c, { ex: TTL });
  return null;
}

export const candidatoAttuale = (chat: number | string) => redis.get<string>(`${kCand(chat)}:ora`);
export const dimenticaCandidati = (chat: number | string) => redis.del(kCand(chat), `${kCand(chat)}:ora`);
export { scarica as scaricaImmagine };

// Per le prove (api/prova-crop?cerca=): ricerca e classificazione di ogni immagine, senza salvare nulla
export async function cercaEClassifica(nome: string, nomeLungo?: string) {
  const urls = ordina([...new Set(await cerca(`${nomeLungo || nome} basket logo`))], nome, nomeLungo);
  const out: { url: string; esito: unknown }[] = [];
  let controllati = 0;
  for (const url of urls) {
    if (controllati >= MAX_CONTROLLI) break;
    const img = await scarica(url);
    if (!img) continue;
    controllati++;
    out.push({ url, esito: await classificaLogo(img, nome, nomeLungo).catch((e) => `errore: ${(e as Error).message}`) });
  }
  return { trovate: urls.length, controllate: out };
}
