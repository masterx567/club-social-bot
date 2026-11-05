// Bozza di didascalia scritta dall'AI (2.0, l'admin 2026-10-19). Resta una proposta: la pubblica solo
// una persona con "✅ Usa questa" oppure riscrivendola. Se Groq non risponde si va avanti senza bozza.
// 2026-10-20 (l'admin): stile copiato dalle didascalie vere. Esempi = le ultime scritte a mano nel bot
// (didascalie:umane) più quelle pubblicate su Instagram (cache didascalie:ig, rinnovata ogni giorno).
import { redis } from "./store";

// Stesso modello del controllo AI: llama-3.3-70b-versatile su Groq dava errore (2026-10-19)
const MODELLO = process.env.GROQ_TEXT_MODEL || process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const K_UMANE = "didascalie:umane";
const K_IG = "didascalie:ig";
const N_ESEMPI = 3;
const RISERVE = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const PROMPT = `Scrivi la didascalia Instagram e Facebook per un post della Società Sportiva Cormano, associazione sportiva dilettantistica di ragazzi.
Copia lo stile degli esempi: stessa struttura, stesse emoji, stesso tono, stessi hashtag.
Struttura tipica:
1. riga titolo: emoji dello sport (⚽ calcio, 🏀 basket, 🏐 volley), CATEGORIA in maiuscolo, "|", esito in maiuscolo (VITTORIA!, SCONFITTA, PAREGGIO) e 💚💛
2. una o due frasi sulla partita
3. riga "🏆 Squadra casa – Squadra ospite punteggio"
4. se ci sono i parziali, riga "📊 I parziali:" e un parziale per riga
5. una frase di incoraggiamento, poi "Forza SS Cormano! 💚💛"
6. hashtag: #SSCormano, lo sport (#Volley #Basket #Calcio), la categoria (#Under14), #ForzaSSCormano
Regole:
- italiano, frasi corte, mai il trattino "-" dentro le frasi
- non inventare nulla: niente nomi di giocatori, marcatori, parziali, commenti del coach o luoghi se non sono nelle informazioni
- se c'è un racconto di chi era lì (per esempio il coach), la parte centrale della didascalia nasce da quello
- vittoria, sconfitta o pareggio si capiscono dal punteggio e da quale squadra è SS Cormano
- massimo 800 caratteri
Rispondi solo con il testo della didascalia.`;

// Eventi (2026-10-24): niente punteggio, la didascalia nasce dai punti chiave scritti da una persona
const PROMPT_EVENTO = `Scrivi la didascalia Instagram e Facebook per un post evento della Società Sportiva Cormano, associazione sportiva dilettantistica di ragazzi.
Copia tono, emoji e hashtag degli esempi.
Struttura: riga titolo con emoji e 💚💛, due o tre frasi che raccontano l'evento usando i punti chiave, ringraziamenti se ci sono, "Forza SS Cormano! 💚💛", hashtag (#SSCormano #ForzaSSCormano e uno o due legati all'evento).
Regole:
- italiano, frasi corte, mai il trattino "-" dentro le frasi
- usa solo i fatti dei punti chiave e del titolo, non inventare nomi, numeri, luoghi o date
- massimo 800 caratteri
Rispondi solo con il testo della didascalia.`;

// 3.0 (2026-10-25): cronaca del coach incollata in risposta alla scheda. Le parole restano sue:
// si taglia a circa metà e si correggono solo gli errori di battitura, dentro un unico blocco 🎙️ "…"
const PROMPT_CRONACA = `Prepara la didascalia Instagram e Facebook di un post della Società Sportiva Cormano a partire dalla cronaca scritta dal coach.
Struttura, in quest'ordine:
1. riga titolo breve: emoji dello sport (⚽ calcio, 🏀 basket, 🏐 volley), poche parole tue sul senso della partita (per esempio "Buona la prima!") e 💚💛
2. riga con il risultato ufficiale come nelle informazioni del post (se ci sono)
3. riga vuota
4. 🎙️ e tra virgolette doppie "…" il testo del coach ACCORCIATO a circa la metà, massimo 900 caratteri
5. riga vuota, poi "Forza SS Cormano! 💚💛"
6. hashtag: #SSCormano #ForzaSSCormano, lo sport e la categoria se ci sono (per esempio #Basket #Under15)
Regole per il testo del coach:
- sono le SUE parole: puoi solo togliere frasi o pezzi di frase, mai riscrivere, riassumere con parole tue o aggiungere
- togli saluti al gruppo (per esempio "Ciao a tutti"), ripetizioni e dettagli minori; tieni le frasi più vive e il risultato finale
- correggi solo errori di battitura, apostrofi, maiuscole e punteggiatura
- il nome della squadra avversaria scrivilo come nel nome ufficiale delle informazioni del post
- mai il trattino "-" dentro le frasi
Rispondi solo con il testo della didascalia.`;

// Torneo (2026-11-01): non si gioca una partita, si dice che abbiamo partecipato al torneo di chi organizza.
// Le informazioni arrivano dalla didascalia della copertina: "TORNEO ORGANIZZATO DA <NOME>\n<CATEGORIA · SPORT>"
const PROMPT_TORNEO = `Scrivi la didascalia Instagram e Facebook per un post della Società Sportiva Cormano, associazione sportiva dilettantistica di ragazzi, che ha partecipato a un torneo.
Copia tono, emoji e hashtag degli esempi.
Struttura: riga titolo con l'emoji dello sport (⚽ calcio, 🏀 basket, 🏐 volley), la CATEGORIA in maiuscolo, "| TORNEO" e 💚💛; una o due frasi sulla partecipazione al torneo e un grazie a chi l'ha organizzato (il nome è nelle informazioni); "Forza SS Cormano! 💚💛"; hashtag #SSCormano, lo sport, la categoria, #ForzaSSCormano.
Regole:
- italiano, frasi corte, mai il trattino "-" dentro le frasi
- non inventare nulla: niente risultati, piazzamenti, vittorie, nomi di giocatori o luoghi se non sono nelle informazioni
- se ci sono indicazioni di chi era lì, usale
- massimo 600 caratteri
Rispondi solo con il testo della didascalia.`;
const TORNEO = /^TORNEO ORGANIZZATO DA /;

// 3.0: post fatto solo di foto, senza informazioni: bozza breve e generica, la persona la completa rispondendo
const PROMPT_FOTO = `Scrivi una didascalia Instagram e Facebook breve per un post di sole foto della Società Sportiva Cormano, associazione sportiva dilettantistica di ragazzi.
Non sai cosa mostrano le foto: resta generico. Su righe separate: titolo con emoji e 💚💛, una o due frasi, "Forza SS Cormano! 💚💛", hashtag #SSCormano #ForzaSSCormano. Se ci sono indicazioni di chi era lì usale, senza inventare altro.
Mai il trattino "-" dentro le frasi, massimo 300 caratteri. Rispondi solo con il testo della didascalia.`;

// Didascalia scritta da una persona nel bot: diventa un esempio per le prossime bozze
export async function ricordaDidascalia(testo: string) {
  if (testo.length < 120) return; // troppo corta per insegnare lo stile
  await redis.lpush(K_UMANE, testo);
  await redis.ltrim(K_UMANE, 0, 29);
}

// Didascalie pubblicate su Instagram, una volta al giorno: solo quelle lunghe con #SSCormano
async function daInstagram(): Promise<string[]> {
  const cache = await redis.get<string[]>(K_IG);
  if (cache) return cache;
  try {
    const t = await redis.get<{ token: string; igUserId: string }>("ig:token");
    if (!t) return [];
    const r = await fetch(`https://graph.facebook.com/v23.0/${t.igUserId}/media?fields=caption&limit=60&access_token=${t.token}`, {
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const lista = ((j.data || []) as { caption?: string }[])
      .map((m) => m.caption || "")
      .filter((c) => c.length >= 150 && /#SSCormano/i.test(c));
    await redis.set(K_IG, lista, { ex: 86_400 });
    return lista;
  } catch {
    return [];
  }
}

// Esempi più simili allo spunto: stesso sport e stessa categoria pesano di più, poi le più recenti
async function esempi(spunto: string): Promise<string[]> {
  const umane = ((await redis.lrange<string>(K_UMANE, 0, -1)) || []).map(String);
  const tutte = [...new Set([...umane, ...(await daInstagram())])];
  const s = spunto.toLowerCase();
  const sport = ["volley", "basket", "calcio"].find((x) => s.includes(x));
  const cat = s.match(/under\s*\d+|open|amatori|dr\d/)?.[0];
  const voto = (c: string) => {
    const l = c.toLowerCase();
    return (sport && l.includes(sport) ? 2 : 0) + (cat && l.replace(/\s/g, "").includes(cat.replace(/\s/g, "")) ? 1 : 0);
  };
  return tutte
    .map((c, i) => ({ c, v: voto(c), i }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, N_ESEMPI)
    .map((x) => x.c);
}

export async function scriviBozza(spunto: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key || !spunto.trim()) return null;
  try {
    const es = await esempi(spunto);
    const testo =
      (spunto.startsWith("EVENTO\n") ? PROMPT_EVENTO : spunto.startsWith("CRONACA\n") ? PROMPT_CRONACA : spunto.startsWith("FOTO\n") ? PROMPT_FOTO : TORNEO.test(spunto) ? PROMPT_TORNEO : PROMPT) +
      (es.length ? `\n\nEsempi di didascalie vere della SS Cormano:\n\n${es.map((e, i) => `ESEMPIO ${i + 1}\n${e}`).join("\n\n")}` : "") +
      `\n\nInformazioni sul post:\n${spunto}`;
    // Limite Groq gratuito per modello (2026-10-25: 200k token al giorno finiti, bozza mai arrivata):
    // se il primo è esaurito si prova il prossimo, ognuno ha i suoi limiti
    let j: any = null;
    for (const model of [MODELLO, ...RISERVE]) {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model,
          temperature: 0.6,
          max_completion_tokens: spunto.startsWith("CRONACA\n") ? 900 : 450,
          ...(model.startsWith("qwen") ? { reasoning_effort: "none" } : model.startsWith("openai/") ? { reasoning_effort: "low" } : {}),
          messages: [{ role: "user", content: testo }],
        }),
      });
      if (r.ok) {
        j = await r.json();
        break;
      }
      console.error(`bozza didascalia ${model}: Groq ${r.status}: ${(await r.text()).slice(0, 150)}`);
    }
    if (!j) return null;
    const t = String(j.choices?.[0]?.message?.content || "")
      .replace(/^["«]|["»]$/g, "")
      .replace(/ - /g, ", ")
      .replace(/[ \t]+$/gm, "") // spazi a fine riga (a capo "markdown" del modello)
      .trim();
    return t && t.length <= 2200 ? t : null;
  } catch (e) {
    console.error("bozza didascalia:", (e as Error).message);
    return null;
  }
}

// ---- 3.0: testo del post dalla cronaca del coach (2026-10-25) ----
// Le parole sono del coach e non si riscrivono: l'AI sceglie solo quali frasi tenere (circa metà) e ne corregge
// gli errori di battitura. Il codice controlla ogni frase: se l'AI l'ha cambiata troppo, torna quella originale.
// Titolo, risultato, "Forza SS Cormano" e hashtag li scrive il codice dai dati ufficiali della copertina.

const SPORT_EMOJI: Record<string, string> = { CALCIO: "⚽", VOLLEY: "🏐", BASKET: "🏀" };
const nomeBello = (s: string) => s.toLowerCase().replace(/(^|[\s'.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

const distanzaTesti = (a: string, b: string) => {
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const riga = [i];
    for (let j = 1; j <= b.length; j++) riga[j] = Math.min(prec[j] + 1, riga[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prec = riga;
  }
  return prec[b.length];
};

// Ritocchi sicuri che non cambiano parole: spazi, punteggiatura ripetuta, punteggi "3-1" → "3 a 1" (niente trattini)
const ritocca = (s: string) =>
  s
    .replace(/(\d+)\s*[-‑–]\s*(\d+)/g, "$1 a $2")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([!?.])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());

export function frasiCronaca(cronaca: string, avversario?: string): string[] {
  let t = cronaca.replace(/^\s*(ciao|buongiorno|buonasera|salve)\b[^,.!\n]*[,.!]?\s*/i, "");
  // Nome avversario scritto quasi giusto: si usa quello ufficiale (es. Giralvolta → Giravolta)
  if (avversario && avversario.length >= 4) {
    t = t.replace(/[\p{L}']+/gu, (w) => (w.toUpperCase() !== avversario.toUpperCase() && w.length >= 4 && distanzaTesti(w.toUpperCase(), avversario.toUpperCase()) <= 2 ? nomeBello(avversario) : w));
  }
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map(ritocca)
    .filter((f) => f.length > 2 && !/^forza\s+linea\s*verde/i.test(f));
}

const parole = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// Le parole di "nuova" stanno in "orig" nello stesso ordine (errori di battitura ammessi), al massimo 2 estranee
export function soloTagli(nuova: string, orig: string): boolean {
  const o = parole(orig);
  const n = parole(nuova);
  let i = 0;
  let estranee = 0;
  for (const w of n) {
    let j = i;
    const vicina = (x: string) => distanzaTesti(w, x) <= Math.max(1, Math.floor(w.length * 0.25));
    // anche due parole attaccate per correggere ("cala re" → "calare")
    while (j < o.length && !vicina(o[j]) && !(j + 1 < o.length && vicina(o[j] + o[j + 1]))) j++;
    if (j < o.length) i = j + (vicina(o[j]) ? 1 : 2);
    else estranee++;
  }
  return n.length >= 2 && estranee <= 1;
}

async function groq(prompt: string, maxToken: number, temperatura: number): Promise<string | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  for (const model of [MODELLO, ...RISERVE]) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model,
        temperature: temperatura,
        max_completion_tokens: maxToken,
        ...(model.startsWith("qwen") ? { reasoning_effort: "none" } : model.startsWith("openai/") ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    }).catch(() => null);
    if (r?.ok) return String((await r.json()).choices?.[0]?.message?.content || "");
    console.error(`cronaca ${model}: Groq ${r?.status}`);
  }
  return null;
}

// Scelta delle frasi: AI se risponde, altrimenti le prime fino a circa metà più quella del risultato finale
async function scegliFrasi(frasi: string[], avversario: string | undefined, altra: boolean): Promise<string[]> {
  const tot = frasi.join(" ").length;
  const obiettivo = Math.min(800, Math.max(250, Math.round(tot / 2)));
  const prompt = `Hai le frasi numerate della cronaca di una partita scritta dal coach di una squadra di ragazzi.
Accorciala per il post Instagram: in tutto circa ${obiettivo} caratteri. Tieni i passaggi più vivi e il risultato finale, togli ripetizioni, dettagli minori e incisi.${altra ? " Fai una scelta diversa dal solito." : ""}
Puoi togliere frasi intere o pezzi di frase, ma le parole che restano devono essere quelle del coach, nello stesso ordine: mai parole tue, mai sinonimi, mai riassunti. Correggi solo errori di battitura, apostrofi, accenti, maiuscole e punteggiatura, e sistema la punteggiatura dove hai tagliato.${avversario ? ` La squadra avversaria si scrive ${nomeBello(avversario)}.` : ""}
Rispondi solo con JSON: {"frasi":[{"n":1,"testo":"..."}]}, nell'ordine della cronaca.

${frasi.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
  // Due tentativi: l'AI tende a tagliare poco, al secondo giro le si dice di quanto ha sforato
  let migliore: string[] | null = null;
  let richiesta = prompt;
  for (let giro = 0; giro < 2; giro++) {
    const risposta = await groq(richiesta, 1200, altra ? 0.8 : 0.3);
    try {
      const j = JSON.parse(String(risposta).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
      const scelte: { n: number; testo: string }[] = (j.frasi || []).filter((x: any) => Number.isInteger(x.n) && x.n >= 1 && x.n <= frasi.length);
      const viste = new Set<number>();
      const out: string[] = [];
      for (const { n, testo } of scelte.sort((a, b) => a.n - b.n)) {
        if (viste.has(n)) continue;
        viste.add(n);
        const orig = frasi[n - 1];
        const nuova = ritocca(String(testo || ""));
        // Solo tagli e piccole correzioni: se l'AI ha messo parole sue la frase si scarta (quella del risultato finale
        // resta, con le parole originali)
        if (soloTagli(nuova, orig)) out.push(nuova);
        else if (/finale|finisce|termina/i.test(orig)) out.push(orig);
      }
      if (!out.length) continue;
      if (!migliore || out.join(" ").length < migliore.join(" ").length) migliore = out;
      const lung = out.join(" ").length;
      if (lung <= obiettivo * 1.3) break;
      richiesta = `${prompt}\n\nLa tua scelta era di ${lung} caratteri: troppo lunga. Arriva a circa ${obiettivo} caratteri togliendo di più, sempre con le parole del coach.`;
    } catch {
      // risposta non leggibile: si riprova o si passa alla scelta semplice
    }
  }
  if (migliore) {
    // Ancora lunga: via i pezzi centrali più lunghi, restano l'inizio e il risultato finale
    while (migliore.join(" ").length > obiettivo * 1.5 && migliore.length > 2) {
      const centro = migliore.slice(1, -1);
      const lunga = centro.reduce((a, b) => (b.length > a.length ? b : a));
      migliore = migliore.filter((f) => f !== lunga);
    }
    return migliore;
  }
  const out: string[] = [];
  for (const f of frasi) if (out.join(" ").length < obiettivo) out.push(f);
  const finale = [...frasi].reverse().find((f) => /finale|finisce|termina/i.test(f));
  if (finale && !out.includes(finale)) out.push(finale);
  return out;
}

// fatti = didascalia della copertina, es. "SS CORMANO 91 - 32 GIRAVOLTA\nUNDER 15 · BASKET" ("Post di foto" per i post foto)
export async function testoCronaca(fatti: string, cronaca: string, altra = false): Promise<string | null> {
  const m = fatti.match(/^(.+?) (\d{1,3}) - (\d{1,3}) (.+)$/m);
  const cat = fatti.split("\n")[1] || "";
  const [categoria, sport] = cat.split(" · ").map((s) => s.trim());
  const avversario = m ? [m[1], m[4]].find((s) => !/linea\s*verde/i.test(s))?.split(" ").find((w) => w.length >= 4) : undefined;
  const frasi = frasiCronaca(cronaca, avversario);
  if (!frasi.length) return null;
  const scelte = await scegliFrasi(frasi, avversario, altra);
  let titolo = "📸 SS Cormano 💚💛";
  let risultato = "";
  if (TORNEO.test(fatti)) titolo = `${SPORT_EMOJI[sport] || "🏆"} ${categoria} | TORNEO 💚💛`;
  if (m) {
    const [, a, x, y, b] = m;
    const lvCasa = /linea\s*verde/i.test(a);
    const [noi, loro] = lvCasa ? [+x, +y] : [+y, +x];
    const esito = noi > loro ? "VITTORIA!" : noi < loro ? "SCONFITTA" : "PAREGGIO";
    titolo = `${SPORT_EMOJI[sport] || "🏆"} ${categoria} | ${esito} 💚💛`;
    risultato = `🏆 ${nomeBello(a)} ${x}, ${nomeBello(b)} ${y}`;
  }
  const tag = ["#SSCormano", "#ForzaSSCormano", ...(sport ? [`#${nomeBello(sport)}`] : []), ...(categoria ? [`#${nomeBello(categoria).replace(/[^\p{L}\p{N}]/gu, "")}`] : [])];
  const testo = `${titolo}\n${risultato ? `${risultato}\n` : ""}\n🎙️ "${scelte.join(" ")}"\n\nForza SS Cormano! 💚💛\n${tag.join(" ")}`;
  return testo.length <= 2200 ? testo : null;
}

// ---- Facebook: domanda finale per invitare a commentare (Issue 5, 2026-11-01) ----
// Solo nel testo che esce su Facebook, solo per i post risultato. Instagram resta com'è.
// Scelta per esito; tra due frasi si sceglie in modo stabile dal testo (un nuovo tentativo dà la stessa frase).
const DOMANDE_FB: Record<string, string[]> = {
  vittoria: ["Eravate al palazzetto a tifare? Scrivetelo qui sotto 👇", "Che partita! Qual è stato il momento più bello? Raccontatelo qui sotto 👇"],
  sconfitta: ["Un incoraggiamento per i ragazzi? Scrivetelo qui sotto 👇", "Un pensiero per la squadra? Scrivetelo qui sotto 👇"],
  pareggio: ["Eravate presenti? Raccontateci com'è andata qui sotto 👇", "Come l'avete vissuta? Scrivetelo qui sotto 👇"],
  altro: ["Eravate con noi? Scrivetelo qui sotto 👇", "Chi c'era a tifare? Fatevi sentire qui sotto 👇"],
};

export function conDomandaFb(caption: string, tipo?: string): string {
  if (tipo !== "risultato" || /👇/.test(caption)) return caption;
  const righe = caption.split("\n");
  const i = righe.findIndex((r) => /^Forza SS Cormano!/i.test(r.trim()));
  if (i < 0) return caption;
  const l = caption.toLowerCase();
  const esito = /vittoria/.test(l) ? "vittoria" : /sconfitta/.test(l) ? "sconfitta" : /pareggio/.test(l) ? "pareggio" : "altro";
  const lista = DOMANDE_FB[esito];
  let h = 0;
  for (const c of caption) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  righe.splice(i + 1, 0, "", lista[h % lista.length]);
  return righe.join("\n");
}
