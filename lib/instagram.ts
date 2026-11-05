import crypto from "crypto";
import { registraPost, salvaIdSocial, type TipoPost } from "./registro";
import { redis, type Ente } from "./store";
import { avvisaAdmin, inviaFoto, tg } from "./telegram";
import { idArgomento, nelThread } from "./argomenti";
import { controllaPost } from "./controlli";
import { conDomandaFb, ricordaDidascalia, scriviBozza, testoCronaca } from "./bozza";
import { ritaglia45 } from "./crop";
import { inProva, v3 } from "./prova";
import { dividiHashtag } from "./altTesto";
import { gestisciTagRifiutati, perMeta, tagSlide, type Tag } from "./account";
import { conta, registraErrore } from "./eventi";
import { del, put } from "@vercel/blob";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpeg from "ffmpeg-static";

// Due modi di collegarsi a Meta, scelti con env META_LOGIN:
// - "instagram": login Instagram, pubblica solo su Instagram. Il crossposting su Facebook
//   lo fa Instagram con "Condividi su Facebook" (da verificare che valga per i post da API, 2026-10-08).
// - "facebook" (predefinito, scelta dell'admin 2026-10-08: doppia pubblicazione dal bot): login Facebook (Graph API), pubblica su Instagram e sulla Pagina Facebook insieme.
//   Requisiti: Instagram professionale collegato alla Pagina, chi fa login è admin della Pagina.
// Instagram e Facebook scaricano le immagini da un URL pubblico: le serviamo noi da Redis (/api/instagram?img=).
const MODO = process.env.META_LOGIN === "instagram" ? "instagram" : "facebook";
const GRAPH_FB = "https://graph.facebook.com/v23.0";
const GRAPH_IG = "https://graph.instagram.com/v23.0";
const SCOPE_FB =
  "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management," +
  "instagram_manage_insights,read_insights,instagram_manage_comments";
// instagram_manage_comments (hashtag nel primo commento): tolto il 2/11 per "Invalid Scopes", rimesso dopo che
// l'admin l'ha aggiunto all'app nel pannello sviluppatori Meta. Se torna "Invalid Scopes" va tolto di nuovo. // statistiche. NON aggiungere pages_read_user_content: "Invalid Scopes", blocca il login (2026-10-08)
const SCOPE_IG = "instagram_business_basic,instagram_business_content_publish";
const TTL = 7 * 86_400; // bottoni validi 7 giorni, poi immagini e post spariscono
const MAX_SLIDE = 10; // limite Instagram per carosello
const DOVE = MODO === "facebook" ? "Instagram e Facebook" : "Instagram";

export const redirectUri = () => `${process.env.BASE_URL}/api/instagram`;

// tipo "instagram": token utente Instagram (60 giorni, rinnovato dal cron), igUserId = utente
// tipo "facebook": token di Pagina (non scade), igUserId = account Instagram collegato alla Pagina
interface Token {
  tipo: "instagram" | "facebook";
  token: string;
  igUserId: string;
  username: string;
  pageId?: string;
  pageName?: string;
  creato: number;
  permessi?: string[]; // permessi dati al login (Facebook), letti da /me/permissions
}
interface Post {
  n: number;
  avversari?: string[][]; // partite della settimana: avversarie per slide (Issue 10)
  caption: string;
  serveDidascalia?: boolean; // post manuali: la didascalia la scrive una persona (2026-10-10)
  didascaliaScritta?: boolean;
  evento?: boolean; // eventi: prima i punti chiave, poi la bozza AI parte da quelli (2026-10-24)
  puntiDati?: boolean;
  mio?: string; // 3.0: ultimo testo scritto da una persona in risposta alla scheda, per "📝 Usa il mio testo così com'è"
  tipo?: TipoPost; // registro dei post pubblicati (2026-10-26)
  categoria?: string;
  ente?: Ente; // statistiche 3.0: campionato del risultato
  auto?: boolean;
  alt?: string; // testo alternativo della grafica (Issue 6)
}
type Msg = { chat_id: number; message_id: number };

const graphDi = (t: Token) => (t.tipo === "facebook" ? GRAPH_FB : GRAPH_IG);

async function graph<T = any>(url: string, params: Record<string, string>, metodo: "GET" | "POST" = "GET"): Promise<T> {
  const qs = new URLSearchParams(params);
  const r = metodo === "GET" ? await fetch(`${url}?${qs}`) : await fetch(url, { method: "POST", body: qs });
  const j = await r.json();
  if (j.error) throw new Error(`Meta: ${j.error.message || JSON.stringify(j.error)}`);
  return j;
}

// Link di login (una tantum, o quando il token scade)
export async function linkLogin(): Promise<string> {
  const state = crypto.randomBytes(24).toString("base64url");
  await redis.set(`igoauth:${state}`, 1, { ex: 600 });
  const u =
    MODO === "facebook" ? new URL("https://www.facebook.com/v23.0/dialog/oauth") : new URL("https://www.instagram.com/oauth/authorize");
  u.search = new URLSearchParams({
    ...(MODO === "instagram" ? { enable_fb_login: "0", force_authentication: "1" } : {}),
    client_id: process.env.IG_APP_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: MODO === "facebook" ? SCOPE_FB : SCOPE_IG,
    state,
  }).toString();
  return u.toString();
}

// Codice del login -> token salvato in Redis. Ritorna cosa è stato collegato.
export async function collega(code: string, state: string): Promise<string> {
  if (!(await redis.getdel(`igoauth:${state}`))) throw new Error("Login scaduto, riapri il link.");
  const app = { client_id: process.env.IG_APP_ID!, client_secret: process.env.IG_APP_SECRET! };

  if (MODO === "instagram") {
    const breve = await graph<{ access_token: string }>(
      "https://api.instagram.com/oauth/access_token",
      { ...app, grant_type: "authorization_code", redirect_uri: redirectUri(), code },
      "POST",
    );
    // Il token breve dura un'ora: subito scambiato con quello lungo (60 giorni)
    const lungo = await graph<{ access_token: string }>("https://graph.instagram.com/access_token", {
      grant_type: "ig_exchange_token",
      client_secret: app.client_secret,
      access_token: breve.access_token,
    });
    const me = await graph<{ user_id: string; username: string }>(`${GRAPH_IG}/me`, { fields: "user_id,username", access_token: lungo.access_token });
    await redis.set<Token>("ig:token", { tipo: "instagram", token: lungo.access_token, igUserId: String(me.user_id), username: me.username, creato: Date.now() });
    return `@${me.username} (solo Instagram)`;
  }

  const breve = await graph<{ access_token: string }>(`${GRAPH_FB}/oauth/access_token`, { ...app, redirect_uri: redirectUri(), code });
  const lungo = await graph<{ access_token: string }>(`${GRAPH_FB}/oauth/access_token`, {
    ...app,
    grant_type: "fb_exchange_token",
    fb_exchange_token: breve.access_token,
  });
  const { data } = await graph<{ data: any[] }>(`${GRAPH_FB}/me/accounts`, {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: lungo.access_token,
  });
  const conIg = data.filter((p) => p.instagram_business_account);
  if (!conIg.length) {
    throw new Error(
      `Nessuna Pagina con Instagram collegato tra quelle autorizzate (${data.map((p) => p.name).join(", ") || "nessuna"}). ` +
        "Collega Instagram alla Pagina e rifai il login.",
    );
  }
  // Più Pagine: preferisce quella di SS Cormano
  const p = conIg.find((x) => /linea\s*verde/i.test(x.name)) || conIg[0];
  // Permessi dati davvero al login: senza instagram_manage_comments gli hashtag restano nella didascalia
  const permessi = await graph<{ data: { permission: string; status: string }[] }>(`${GRAPH_FB}/me/permissions`, { access_token: lungo.access_token })
    .then((r) => r.data.filter((x) => x.status === "granted").map((x) => x.permission))
    .catch(() => [] as string[]);
  await redis.set<Token>("ig:token", {
    tipo: "facebook",
    permessi,
    token: p.access_token,
    igUserId: p.instagram_business_account.id,
    username: p.instagram_business_account.username,
    pageId: p.id,
    pageName: p.name,
    creato: Date.now(),
  });
  return `@${p.instagram_business_account.username} + Pagina "${p.name}"`;
}

// Cron giornaliero. Instagram: il token scade dopo 60 giorni, si rinnova ogni settimana.
// Facebook: il token di Pagina non scade, si controlla solo che funzioni.
export async function rinnovaToken() {
  const t = await redis.get<Token>("ig:token");
  if (!t) return;
  try {
    if (t.tipo === "facebook") {
      await graph(`${GRAPH_FB}/${t.pageId}`, { fields: "id", access_token: t.token });
    } else if (Date.now() - t.creato >= 7 * 86_400_000) {
      const j = await graph<{ access_token: string }>("https://graph.instagram.com/refresh_access_token", {
        grant_type: "ig_refresh_token",
        access_token: t.token,
      });
      await redis.set<Token>("ig:token", { ...t, token: j.access_token, creato: Date.now() });
    }
  } catch (e) {
    const link = `${process.env.BASE_URL}/api/instagram?key=${process.env.SETUP_SECRET}`;
    await avvisaAdmin(`🔑 Collegamento Instagram non valido, rifai il login:\n${link}\n\nDettaglio: ${(e as Error).message}`);
  }
}

// Livello di controllo (scelta dell'admin 2026-10-08, opzione C):
// controlli automatici; se passano si pubblica da soli dopo ATTESA_MIN minuti salvo ❌ di chiunque nel gruppo;
// se non passano (o non si possono fare) serve un ✅ di una persona.
const ATTESA_MIN = 30;

const ora = (ms: number) =>
  new Date(ms).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });

// QStash richiama /api/ig-auto dopo l'attesa: Vercel gratuito non sa programmare azioni ritardate
// ig-auto accetta solo chiamate firmate da QStash e pubblica solo i post segnati qui come automatici:
// un post che aspetta il ✅ non può uscire da quella strada.
async function programma(id: string) {
  await redis.set(`igauto:${id}`, 1, { ex: TTL });
  const dest = `${process.env.BASE_URL}/api/ig-auto?id=${id}`;
  const r = await fetch(`${process.env.QSTASH_URL || "https://qstash.upstash.io"}/v2/publish/${dest}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}`, "Upstash-Delay": `${ATTESA_MIN}m`, "Upstash-Retries": "0" },
  });
  if (!r.ok) throw new Error(`QStash ${r.status}: ${await r.text()}`);
}

// Dopo l'invio nel gruppo: salva le immagini, controlla, e programma la pubblicazione o chiede l'approvazione.
// Se Instagram non è collegato non fa nulla.
// auto = pubblicazione automatica dopo l'attesa: solo partite della settimana e carosello risultati
// (scelta dell'admin 2026-10-08). Grafiche singole (/risultato, /amichevole): sempre un ✅ di una persona.
// copertina = id del messaggio Telegram della copertina (grafiche manuali): rispondendo a quel messaggio
// con altre foto si costruisce il carosello copertina + foto (decisione 2026-10-08).
// flusso + avvisi: controllo dei dati letti dai portali (2026-10-08). Con avvisi (portale non letto, partite
// escluse, orari o risultati mancanti, domande aperte) niente automatico: serve un ✅.
// Una nuova versione dello stesso flusso (es. rifatta dopo le risposte su loghi e nomi) sostituisce la precedente
// non ancora pubblicata, così non escono due post uguali.
// didascaliaUmana: post manuali (copertine, caroselli, eventi). Il bot chiede la didascalia e il ✅ non pubblica
// finché una persona non l'ha scritta; caption fa solo da spunto (decisione dell'admin 2026-10-10).
export interface Opzioni {
  auto?: boolean;
  copertina?: number;
  flusso?: "settimana" | "carosello";
  avvisi?: string[];
  didascaliaUmana?: boolean;
  evento?: boolean;
  rifatto?: boolean; // versione rifatta dopo le risposte: gli avvisi sui dati non fermano l'automatico (2026-10-21)
  tipo?: TipoPost; // per il registro dei post (2026-10-26); senza, si ricava da flusso ed evento
  categoria?: string;
  ente?: Ente;
  alt?: string; // testo alternativo, usato solo se la grafica è una sola
  avversari?: string[][]; // partite della settimana: avversarie per slide, taggate sul logo (Issue 10)
}
const STESSA_VERSIONE = 36 * 3600; // entro 36 ore una nuova versione dello stesso flusso sostituisce la precedente
const MAX_DIDASCALIA = 2200; // limite Instagram
const MAX_HASHTAG = 30; // limite Instagram

export async function proponiInstagram(chatId: number, imgs: Buffer[], caption: string, { auto = false, copertina, flusso, avvisi = [], didascaliaUmana = false, rifatto = false, evento = false, tipo, categoria, ente, alt, avversari }: Opzioni = {}) {
  if (!(await redis.exists("ig:token"))) return;
  if (imgs.length > MAX_SLIDE) {
    await avvisaAdmin(`Instagram: ${imgs.length} slide, il massimo è ${MAX_SLIDE}. Non proposto.`);
    return;
  }
  const id = crypto.randomBytes(12).toString("base64url");
  for (const [i, img] of imgs.entries()) await redis.set(`igimg:${id}:${i}`, img.toString("base64"), { ex: TTL });
  const tipoPost: TipoPost =
    tipo || (flusso === "carosello" ? "carosello risultati" : flusso === "settimana" ? "partite della settimana" : evento ? (caption === "Post di foto" ? "post foto" : "evento") : "risultato");
  await redis.set<Post>(`igpost:${id}`, { n: imgs.length, caption, serveDidascalia: didascaliaUmana || undefined, evento: evento || undefined, tipo: tipoPost, categoria, ente, auto: auto || undefined, alt, avversari }, { ex: TTL });

  if (copertina) {
    const problemi = await controllaPost(imgs, caption);
    await redis.set(`igcover:${chatId}:${copertina}`, id, { ex: TTL });
    await redis.set(`ignext:${id}`, imgs.length, { ex: TTL }); // prossimo indice libero per le foto aggiunte
    for (let i = 0; i < imgs.length; i++) await redis.zadd(`igord:${id}`, { score: i - imgs.length, member: String(i) }); // copertina prima di tutto
    await redis.expire(`igord:${id}`, TTL);
    if (problemi.length) await redis.set(`igprob:${id}`, problemi, { ex: TTL });
    const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: "…" });
    await redis.set<Msg>(`igmsg:${id}`, { chat_id: chatId, message_id: m.message_id }, { ex: TTL });
    // Le foto valgono anche in risposta al messaggio del carosello (2026-10-11: il gruppo rispondeva lì)
    await redis.set(`igcover:${chatId}:${m.message_id}`, id, { ex: TTL });
    if (v3(chatId)) {
      // 3.0: un solo messaggio, la scheda. Avvisi della foto in cima, bozza dentro, risposte di testo alla scheda
      // = materiale per il testo del post (2026-10-25)
      if (avvisi.length) {
        await redis.hset(`igavv:${id}`, Object.fromEntries(avvisi.map((a, i) => [`c${i}`, a])));
        await redis.expire(`igavv:${id}`, TTL);
      }
      await redis.set(`igcop:${id}`, copertina, { ex: TTL });
      await redis.set(`igdid:${chatId}:${m.message_id}`, id, { ex: TTL });
      await redis.set(`igfatti:${id}`, caption, { ex: TTL });
      await redis.set(`igspunto:${id}`, evento ? `FOTO\n${caption}` : caption, { ex: TTL });
      await nuovaBozza(id);
      return;
    }
    await aggiornaManuale(id);
    await redis.set(`igcop:${id}`, copertina, { ex: TTL });
    if (didascaliaUmana) await chiediDidascalia(id, chatId);
    return;
  }

  // Versione rifatta: esce da sola tra 30 minuti come le altre; la fermano solo il controllo AI e un doppione
  const problemi = [...(rifatto ? [] : avvisi), ...(await controllaPost(imgs, caption))];
  if (flusso) {
    const prec = await redis.get<string>(`igultimo:${chatId}:${flusso}`);
    if (prec) {
      if (await redis.set(`iglock:${prec}`, "sostituito", { nx: true, ex: TTL })) {
        const vecchio = await redis.get<Msg>(`igmsg:${prec}`);
        if (vecchio) await tg("editMessageText", { ...vecchio, text: "🔁 Sostituito dalla versione aggiornata più sotto." }).catch(() => {});
      } else if (String(await redis.get(`iglock:${prec}`)) === "1") {
        problemi.push("la versione precedente è già pubblicata: controlla prima di pubblicare anche questa");
      }
    }
    await redis.set(`igultimo:${chatId}:${flusso}`, id, { ex: STESSA_VERSIONE });
  }
  // Gruppo di prova: mai la pubblicazione automatica (la coda è quella vera)
  if (auto && inProva(chatId)) problemi.push(problemi.length ? "🧪 PROVA: niente pubblicazione automatica" : "🧪 PROVA: qui sarebbe andato in coda da solo dopo 30 minuti");
  let automatico = auto && problemi.length === 0;
  if (!auto && !problemi.length) problemi.push("grafica singola: si pubblica solo con un ✅");
  if (automatico) {
    try {
      await programma(id);
    } catch (e) {
      automatico = false;
      problemi.push("pubblicazione automatica non programmabile");
      await avvisaAdmin(`⚠️ ${(e as Error).message}`);
    }
  }

  const testo = automatico
    ? // Di notte il post entra in coda ma esce solo dalle NOTTE_A: lo si dice subito (l'admin 2026-10-29, messaggio alle 00:48)
      `📲 Alle ${ora(Date.now() + ATTESA_MIN * 60_000)} (tra ${ATTESA_MIN} min) va in coda per ${DOVE}, se nessuno annulla.\nUscita prevista: ${quando(await uscitaInCoda(Date.now() + ATTESA_MIN * 60_000))} (di notte, dalle ${NOTTE_DA} alle ${NOTTE_A}, non esce niente).`
    : `⚠️ ${DOVE}: serve un ✅ per metterlo in coda.\n${problemi.map((p) => `• ${p}`).join("\n")}`;
  const bottoni = automatico
    ? [{ text: "❌ Annulla", callback_data: `igx:${id}` }, { text: "✅ In coda subito", callback_data: `ig:${id}` }]
    : [{ text: "✅ Pubblica", callback_data: `ig:${id}` }, { text: "❌ Scarta", callback_data: `igx:${id}` }];
  const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: testo, reply_markup: { inline_keyboard: [bottoni, bottoniModifica(id)] } });
  await redis.set<Msg>(`igmsg:${id}`, { chat_id: chatId, message_id: m.message_id }, { ex: TTL });
  // Anche ai post automatici si aggiungono foto e video, rispondendo a questo messaggio (2026-10-17)
  await redis.set(`igcover:${chatId}:${m.message_id}`, id, { ex: TTL });
}

// ✏️ Modifica didascalia (2026-10-17): su ogni messaggio di un post non ancora pubblicato
const bottoneModifica = (id: string) => ({ text: "✏️ Modifica didascalia", callback_data: `iged:${id}` });
const bottoneFoto = (id: string) => ({ text: "🖼 Modifica foto", callback_data: `igfo:${id}` });
const bottoniModifica = (id: string) => [bottoneModifica(id), bottoneFoto(id)];

// 🖼 Modifica foto (2026-10-17): messaggio a cui rispondere con foto o video, con 🗑 per togliere l'ultima.
// Vale per ogni post non ancora pubblicato, anche automatico o già in coda.
export async function suModificaFoto(q: any) {
  const id = String(q.data).slice(5);
  const [p, lucchetto] = await Promise.all([redis.get<Post>(`igpost:${id}`), redis.get(`iglock:${id}`)]);
  if (!p || (lucchetto !== null && String(lucchetto) !== IN_CODA)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: p ? "Già pubblicato o scartato: le foto non cambiano più." : "Post scaduto.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const chat = q.message.chat.id;
  const n = (await slides(id, p)).length;
  const d = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chat,
    text: `🖼 Modifica foto: ${n}/${MAX_SLIDE} slide.
Rispondi a questo messaggio con foto o video per aggiungerli in fondo.
🗑 toglie l'ultima aggiunta (la prima slide resta).`,
    reply_parameters: { message_id: q.message.message_id, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[{ text: "🗑 Togli ultima", callback_data: `igdel:${id}` }]] },
  });
  await redis.set(`igcover:${chat}:${d.message_id}`, id, { ex: TTL });
  await redis.set<Msg>(`igfomsg:${id}`, { chat_id: chat, message_id: d.message_id }, { ex: TTL });
}

// Il messaggio 🖼 Modifica foto tiene il conteggio aggiornato dopo ogni foto o video aggiunto o tolto
async function aggiornaMsgFoto(id: string) {
  const [m, p] = await Promise.all([redis.get<Msg>(`igfomsg:${id}`), redis.get<Post>(`igpost:${id}`)]);
  if (!m || !p) return;
  const n = (await slides(id, p)).length;
  const nv = await redis.hlen(kVid(id));
  await tg("editMessageText", {
    ...m,
    text: `🖼 Modifica foto: ${n}/${MAX_SLIDE} slide${nv ? `, di cui ${nv} video` : ""}.\nRispondi a questo messaggio con foto o video per aggiungerli in fondo.\n🗑 toglie l'ultima aggiunta (la prima slide resta).`,
    reply_markup: { inline_keyboard: [[{ text: "🗑 Togli ultima", callback_data: `igdel:${id}` }]] },
  }).catch(() => {});
}

export async function suModificaDidascalia(q: any) {
  const id = String(q.data).slice(5);
  const [p, lucchetto] = await Promise.all([redis.get<Post>(`igpost:${id}`), redis.get(`iglock:${id}`)]);
  if (!p || (lucchetto !== null && String(lucchetto) !== IN_CODA)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: p ? "Già pubblicato o scartato: la didascalia non cambia più." : "Post scaduto.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const chat = q.message.chat.id;
  const d = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chat,
    text: `✏️ Scrivi la nuova didascalia: rispondi a questo messaggio.\n\nDidascalia attuale:\n${p.caption}`,
    reply_parameters: { message_id: q.message.message_id, allow_sending_without_reply: true },
    reply_markup: { force_reply: true, selective: false },
  });
  // La risposta passa da suDidascalia, come la prima didascalia
  await redis.set(`igdid:${chat}:${d.message_id}`, id, { ex: TTL });
}

// ---- Caroselli manuali: copertina + foto aggiunte rispondendo alla copertina ----

// Indici delle slide in ordine. Manuali: sorted set (copertina, poi foto per id messaggio Telegram);
// automatici: 0..n-1.
async function slides(id: string, p: Post): Promise<number[]> {
  const z = await redis.zrange<string[]>(`igord:${id}`, 0, -1);
  return z.length ? z.map(Number) : Array.from({ length: p.n }, (_, i) => i);
}

async function aggiornaManuale(id: string, tentativi = 3): Promise<void> {
  // Già in coda: il messaggio del post è quello della coda, si aggiorna quello (foto aggiunte dopo il ✅)
  if (String(await redis.get(`iglock:${id}`)) === IN_CODA) return aggiornaCoda();
  const [msg, p, problemi, avvisi, inCorso] = await Promise.all([
    redis.get<Msg>(`igmsg:${id}`),
    redis.get<Post>(`igpost:${id}`),
    redis.get<string[]>(`igprob:${id}`),
    redis.hgetall<Record<string, string>>(`igavv:${id}`),
    redis.get<number>(`igin:${id}`),
  ]);
  if (!msg || !p) return;
  const n = (await slides(id, p)).length;
  const nVideo = await redis.hlen(kVid(id));
  if (v3(msg.chat_id)) return scheda(id, msg, p, n, nVideo, Number(inCorso) > 0, [...(problemi || []).map((x) => `copertina: ${x}`), ...Object.values(avvisi || {})], tentativi);
  const breve = (s: string) => (s.length > 90 ? `${s.slice(0, 90)}…` : s).replace(/\s+/g, " ");
  const righe = [
    `✍️ Carosello per ${DOVE}: copertina${n - 1 - nVideo > 0 ? ` + ${n - 1 - nVideo} foto` : ""}${nVideo ? ` + ${nVideo} video` : ""} (${n}/${MAX_SLIDE} slide)`,
    ...(nVideo && MODO === "facebook" ? ["🎬 Su Facebook escono solo le foto: un post Facebook non può avere foto e video insieme."] : []),
    ...(Number(inCorso) > 0 ? ["⏳ Sto preparando le foto appena arrivate…"] : []),
    "Rispondi alla copertina o a questo messaggio con altre foto o video per aggiungerli. Con ✅ va in coda (un post ogni 2 ore, mai tra le 23 e le 8).",
    ...(p.serveDidascalia
      ? [p.didascaliaScritta ? `📝 Didascalia: ${breve(p.caption)}` : "✍️ Manca la didascalia: rispondi al messaggio ✍️ qui sotto."]
      : []),
    ...(problemi || []).map((x) => `⚠️ copertina: ${x}`),
    ...Object.values(avvisi || {}).map((x) => `⚠️ ${x}`),
  ];
  const bottoni = [
    { text: "✅ Pubblica", callback_data: `ig:${id}` },
    { text: "❌ Scarta", callback_data: `igx:${id}` },
    ...(n > 1 ? [{ text: "🗑 Togli ultima", callback_data: `igdel:${id}` }] : []),
  ];
  try {
    const riga2 = p.serveDidascalia && !p.didascaliaScritta ? [[bottoneFoto(id)]] : [bottoniModifica(id)];
    await tg("editMessageText", { ...msg, text: righe.join("\n"), reply_markup: { inline_keyboard: [bottoni, ...riga2] } });
  } catch (e) {
    // Album di molte foto = molte modifiche insieme, Telegram frena ("retry after N"):
    // si aspetta e si rilegge lo stato, altrimenti il conteggio resta indietro
    const attesa = Number((e as Error).message.match(/retry after (\d+)/i)?.[1]);
    if (attesa && tentativi > 0) {
      await new Promise((ok) => setTimeout(ok, Math.min(attesa, 15) * 1000));
      return aggiornaManuale(id, tentativi - 1);
    }
  }
}

// ---- 3.0: scheda unica del post (2026-10-25) ----
// Un messaggio che si aggiorna da solo: avvisi in cima, foto, testo del post e bottoni.
// ✅ Pubblica con questo testo = un tocco (testo + coda). Si cambia il testo rispondendo alla scheda:
// due parole (la bozza si riscrive) o la cronaca del coach (🎙️ "sue parole", tagliate). 📝 = il testo scritto, tale e quale.
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function scheda(id: string, msg: Msg, p: Post, n: number, nVideo: number, inCorso: boolean, avvisi: string[], tentativi: number): Promise<void> {
  const [bozza, inPrep, note] = await Promise.all([redis.get<string>(`igbozza:${id}`), redis.get(`igbozprep:${id}`), redis.get<string[]>(`ignote:${id}`)]);
  const allarmi = [...avvisi.map((a) => `⚠️ ${a[0].toUpperCase()}${a.slice(1)}`), ...(note || [])];
  const righe = [
    ...(allarmi.length ? [...allarmi.map((a) => `<b>${html(a)}</b>`), ""] : []),
    `📸 Copertina${n - 1 - nVideo > 0 ? ` + ${n - 1 - nVideo} foto` : ""}${nVideo ? ` + ${nVideo} video` : ""} (${n}/${MAX_SLIDE})`,
    ...(inCorso ? ["⏳ Sto preparando le foto appena arrivate…"] : []),
    "Altre foto? Mandale in risposta alla copertina.",
    "",
    inPrep ? "✍️ Preparo il testo del post… ⏳" : bozza ? `✍️ <b>Testo del post</b>\n\n${html(bozza)}` : "✍️ La bozza automatica ora non è disponibile.",
    "",
    "💬 Vuoi cambiarlo? <b>Rispondi a questo messaggio</b> con quello che vuoi: due parole o la cronaca del coach.",
    ...(p.mio ? ["📝 Il tuo testo è salvato: con 📝 lo pubblico così com'è."] : []),
  ];
  const tastiera = [
    ...(bozza && !inPrep ? [[{ text: "✅ Pubblica con questo testo", callback_data: `igp3:${id}` }]] : []),
    [{ text: "🔄 Un'altra", callback_data: `igbr:${id}` }, ...(p.mio ? [{ text: "📝 Usa il mio testo così com'è", callback_data: `igmy:${id}` }] : [])],
    [...(n > 1 ? [{ text: "🗑 Togli ultima foto", callback_data: `igdel:${id}` }] : []), { text: "❌ Scarta", callback_data: `igx:${id}` }],
  ];
  try {
    await tg("editMessageText", { ...msg, text: righe.join("\n"), parse_mode: "HTML", reply_markup: { inline_keyboard: tastiera } });
  } catch (e) {
    const attesa = Number((e as Error).message.match(/retry after (\d+)/i)?.[1]);
    if (attesa && tentativi > 0) {
      await new Promise((ok) => setTimeout(ok, Math.min(attesa, 15) * 1000));
      return aggiornaManuale(id, tentativi - 1);
    }
  }
}

// Bozza nuova dallo spunto attuale (fatti del post, eventualmente con la cronaca o le parole di chi scrive)
async function nuovaBozza(id: string, altra = false) {
  if (altra) await conta("bozza_altra", (await redis.get<Msg>(`igmsg:${id}`))?.chat_id);
  await redis.set(`igbozprep:${id}`, 1, { ex: 120 });
  await aggiornaManuale(id);
  const [fatti, cronaca, spunto] = await Promise.all([redis.get<string>(`igfatti:${id}`), redis.get<string>(`igcron:${id}`), redis.get<string>(`igspunto:${id}`)]);
  // Cronaca del coach: le sue parole scelte e controllate dal codice (testoCronaca); altrimenti la bozza AI
  const bozza = cronaca && fatti ? await testoCronaca(fatti, cronaca, altra) : await scriviBozza(spunto || "");
  if (bozza) await redis.set(`igbozza:${id}`, bozza, { ex: TTL });
  else await redis.del(`igbozza:${id}`);
  // Note sulla cronaca: punteggio diverso dalla grafica, nome avversario corretto (solo se il testo l'ha corretto davvero)
  if (cronaca && fatti) await redis.set(`ignote:${id}`, noteCronaca(fatti, cronaca, bozza || ""), { ex: TTL });
  else await redis.del(`ignote:${id}`);
  await redis.del(`igbozprep:${id}`);
  await aggiornaManuale(id);
}

const distanza = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

// fatti = "SS CORMANO 91 - 32 GIRAVOLTA\nUNDER 15 · BASKET" (didascalia della copertina)
export function noteCronaca(fatti: string, cronaca: string, bozza: string): string[] {
  const m = fatti.match(/^(.+?) (\d{1,3}) - (\d{1,3}) (.+)$/m);
  if (!m) return [];
  const note: string[] = [];
  const [, a, x, y, b] = m;
  // Ultimo risultato "finale" citato (la cronaca dice anche "il finale del quarto"), altrimenti l'ultimo punteggio
  const fin = [...cronaca.matchAll(/(?:finale|finisce|termina)[^\d]{0,30}(\d{1,3})\s*(?:a|-|–)\s*(\d{1,3})/gi)].at(-1) ??[...cronaca.matchAll(/(\d{1,3})\s*(?:a|-|–)\s*(\d{1,3})/gi)].at(-1);
  const ord = (p: number, q: number) => [p, q].sort((s, t) => s - t).join(",");
  if (fin && ord(+fin[1], +fin[2]) !== ord(+x, +y)) note.push(`⚠️ Nel testo il risultato è ${fin[1]} a ${fin[2]}, sulla grafica ${x} a ${y}`);
  for (const squadra of [a, b].filter((s) => !/linea\s*verde/i.test(s))) {
    const uff = squadra.split(" ").find((w) => w.length >= 4);
    if (!uff) continue;
    const scritta = (cronaca.match(/[\p{L}']+/gu) || []).find((w) => w.toUpperCase() !== uff && w.length >= 4 && distanza(w.toUpperCase(), uff) <= 2);
    if (scritta && !new RegExp(`\\b${scritta}\\b`, "i").test(bozza) && bozza.toUpperCase().includes(uff)) {
      note.push(`✏️ Corretto ${scritta} in ${uff[0]}${uff.slice(1).toLowerCase()}`);
    }
  }
  return note;
}

// Testo scritto in risposta alla scheda (3.0). Lungo = cronaca del coach, corto = indicazioni per la bozza.
async function testoDallaScheda(id: string, p: Post, testo: string, m: any) {
  const valido = testo.length <= MAX_DIDASCALIA && (testo.match(/#[\p{L}\p{N}_]+/gu) || []).length <= MAX_HASHTAG;
  await redis.set<Post>(`igpost:${id}`, { ...p, mio: valido ? testo : undefined }, { keepTtl: true });
  const fatti = (await redis.get<string>(`igfatti:${id}`)) || p.caption;
  if (testo.length >= 200) {
    await conta("cronaca_coach", m.chat?.id);
    await redis.set(`igcron:${id}`, testo, { ex: TTL });
    await redis.set(`igspunto:${id}`, `CRONACA\nInformazioni del post (nomi e risultato ufficiali):\n${fatti}\n\nCronaca del coach:\n${testo}`, { ex: TTL });
  } else {
    await redis.del(`igcron:${id}`);
    await redis.set(`igspunto:${id}`, `${p.evento ? "FOTO\n" : ""}${fatti}\nIndicazioni di chi era lì (usale nel testo): ${testo}`, { ex: TTL });
  }
  await tg("setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👀" }] }).catch(() => {});
  await nuovaBozza(id);
  await tg("setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] }).catch(() => {});
}

// ✅ Pubblica con questo testo / 📝 Usa il mio testo così com'è: testo salvato e post pronto in un tocco
export async function suPubblicaTesto(q: any) {
  const [tipo, id] = String(q.data).split(":");
  const [p, bozza] = await Promise.all([redis.get<Post>(`igpost:${id}`), redis.get<string>(`igbozza:${id}`)]);
  const testo = tipo === "igmy" ? p?.mio : bozza;
  if (!p || !testo) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: p ? "Testo non disponibile: rispondi alla scheda con il testo." : "Post scaduto.", show_alert: true });
    return;
  }
  await redis.set<Post>(`igpost:${id}`, { ...p, caption: testo, didascaliaScritta: true }, { keepTtl: true });
  await conta(tipo === "igmy" ? "pubblica_mio" : "pubblica_bozza", q.message?.chat?.id);
  if (tipo === "igmy") await ricordaDidascalia(testo).catch(() => {});
  await suBottoneInstagram({ ...q, data: `ig:${id}` });
}

// Domanda "✍️ Scrivi la didascalia" (post manuali). Sta sempre per ultima nel gruppo: dopo le foto aggiunte
// la vecchia domanda si cancella e ne arriva una nuova sotto, così prima si finiscono le foto e poi si scrive
// la didascalia (2026-10-11). Le foto mandate in risposta alla domanda vanno comunque nel carosello.
async function chiediDidascalia(id: string, chatId: number) {
  if (v3(chatId)) return; // 3.0: niente domanda a parte, il testo sta nella scheda
  const [p, copertina, vecchia] = await Promise.all([
    redis.get<Post>(`igpost:${id}`),
    redis.get<number>(`igcop:${id}`),
    redis.get<Msg>(`igdom:${id}`),
  ]);
  if (!p?.serveDidascalia || p.didascaliaScritta) return;
  if (await redis.exists(`iglock:${id}`)) return;
  const n = (await slides(id, p)).length;
  if (vecchia) await tg("deleteMessage", vecchia).catch(() => {});
  const chiediPunti = p.evento && !p.puntiDati;
  const testa = chiediPunti
    ? `📸 ${n > 1 ? `Copertina + ${n - 1} foto.` : "Altre foto? Mandale prima, in risposta alla copertina o a questo messaggio."}
✍️ Raccontami l'evento in poche righe: cosa, chi, dove, com'è andata, chi ringraziare. Rispondi a questo messaggio e scrivo io la didascalia.
Hai già la didascalia pronta, con gli hashtag? Mandala qui e la uso così com'è.`
    : n > 1
      ? `📸 Copertina + ${n - 1} foto. Hai finito con le foto?\n✍️ Ora scrivi la didascalia del post: rispondi a questo messaggio.`
      : "📸 Vuoi altre foto? Mandale prima, in risposta alla copertina o a questo messaggio.\n✍️ Poi scrivi la didascalia del post: rispondi a questo messaggio.";
  const d = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: chiediPunti ? testa : `${testa}\nSenza didascalia non si pubblica.\n\nSpunto:\n${p.caption}`,
    ...(copertina ? { reply_parameters: { message_id: Number(copertina), allow_sending_without_reply: true } } : {}),
    reply_markup: { force_reply: true, selective: false },
  });
  await redis.set(`igdid:${chatId}:${d.message_id}`, id, { ex: TTL });
  await redis.set(`igcover:${chatId}:${d.message_id}`, id, { ex: TTL }); // anche qui una foto va nel carosello
  await redis.set<Msg>(`igdom:${id}`, { chat_id: chatId, message_id: d.message_id }, { ex: TTL });
  if (chiediPunti) return; // la bozza parte dai punti chiave
  if (!(await redis.exists(`igspunto:${id}`))) await redis.set(`igspunto:${id}`, p.caption, { ex: TTL });
  await mandaBozza(id, chatId);
}

// Bozza AI sotto la domanda ✍️ (2.0): ✅ la usa così, 🔄 ne scrive un'altra, oppure si risponde col testo
// corretto. Senza un tocco umano non si pubblica, come prima.
async function mandaBozza(id: string, chatId: number, nuova = false) {
  const vecchio = await redis.get<Msg>(`igbozmsg:${id}`);
  if (vecchio) await tg("deleteMessage", vecchio).catch(() => {});
  let bozza = nuova ? null : await redis.get<string>(`igbozza:${id}`);
  if (!bozza) bozza = await scriviBozza((await redis.get<string>(`igspunto:${id}`)) || "");
  if (!bozza) {
    // Mai in silenzio (l'admin 2026-10-25, "si è bloccato"): si dice che l'AI non risponde e come andare avanti
    const d = await tg<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: "🤖 La bozza automatica ora non è disponibile (AI esaurita per oggi).\n✍️ Scrivi tu la didascalia completa: rispondi a questo messaggio e la uso così com'è.",
      reply_markup: { force_reply: true, selective: false },
    });
    await redis.set(`igdid:${chatId}:${d.message_id}`, id, { ex: TTL });
    await redis.set(`igmanuale:${chatId}:${d.message_id}`, 1, { ex: TTL });
    return;
  }
  await redis.set(`igbozza:${id}`, bozza, { ex: TTL });
  const d = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: `🤖 Bozza di didascalia:

${bozza}

Va bene? Premi ✅. Per correggerla rispondi a questo messaggio col testo giusto.`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Usa questa", callback_data: `igbz:${id}` }, { text: "🔄 Un'altra", callback_data: `igbr:${id}` }],
        [{ text: "🗣 Spiego io", callback_data: `igbc:${id}` }, { text: "✍️ Scrivo io", callback_data: `igbm:${id}` }],
      ],
    },
  });
  await redis.set(`igdid:${chatId}:${d.message_id}`, id, { ex: TTL });
  await redis.set<Msg>(`igbozmsg:${id}`, { chat_id: chatId, message_id: d.message_id }, { ex: TTL });
}

// ✅ Usa questa / 🔄 Un'altra sulla bozza AI
export async function suBozza(q: any) {
  const usa = String(q.data).startsWith("igbz:");
  const id = String(q.data).slice(5);
  const chat = q.message.chat.id;
  const [p, lucchetto, bozza] = await Promise.all([redis.get<Post>(`igpost:${id}`), redis.get(`iglock:${id}`), redis.get<string>(`igbozza:${id}`)]);
  if (!p || (lucchetto !== null && String(lucchetto) !== IN_CODA)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: p ? "Già pubblicato o scartato." : "Post scaduto.", show_alert: true });
    return;
  }
  // 🗣 Spiego io (2026-10-25): qualche riga a parole (es. quelle del coach), la bozza si riscrive partendo da lì
  // ✍️ Scrivo io (2026-10-25): la didascalia la scrive una persona, si salva così com'è, niente AI
  if (String(q.data).startsWith("igbm:")) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    const d = await tg<{ message_id: number }>("sendMessage", {
      chat_id: chat,
      text: "✍️ Scrivi la didascalia completa, rispondendo a questo messaggio. La uso così com'è.",
      reply_markup: { force_reply: true, selective: false },
    });
    await redis.set(`igdid:${chat}:${d.message_id}`, id, { ex: TTL });
    await redis.set(`igmanuale:${chat}:${d.message_id}`, 1, { ex: TTL });
    return;
  }
  if (String(q.data).startsWith("igbc:")) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    const d = await tg<{ message_id: number }>("sendMessage", {
      chat_id: chat,
      text: "🗣 Raccontami in poche righe cosa dire, per esempio le parole del coach. Rispondi a questo messaggio e riscrivo la bozza.",
      reply_markup: { force_reply: true, selective: false },
    });
    await redis.set(`igspiega:${chat}:${d.message_id}`, id, { ex: TTL });
    return;
  }
  if (!usa && v3(chat)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Ne scrivo un'altra…" });
    await nuovaBozza(id, true);
    return;
  }
  if (!usa) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Ne scrivo un'altra…" });
    await mandaBozza(id, chat, true);
    return;
  }
  if (!bozza) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Bozza scaduta: scrivi la didascalia.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Didascalia salvata" });
  await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await salvaDidascalia(id, p, bozza, chat, q.message.message_id, String(lucchetto) === IN_CODA);
}

// Dopo l'ultima foto di un invio (album = più foto in parallelo): aspetta che arrivino tutte, poi una sola domanda
const ATTESA_FOTO_MS = 4000;
async function dopoFoto(id: string, chatId: number) {
  if (v3(chatId)) return; // 3.0: la scheda si aggiorna da sola, niente messaggi di fine caricamento
  const giro = await redis.incr(`igdomgiro:${id}`);
  await redis.expire(`igdomgiro:${id}`, 3600);
  await new Promise((ok) => setTimeout(ok, ATTESA_FOTO_MS));
  if (Number(await redis.get(`igdomgiro:${id}`)) !== giro) return; // è arrivata un'altra foto: ci pensa lei
  if (Number(await redis.get(`igin:${id}`)) > 0) return; // ancora foto in lavorazione: l'ultima a finire richiama dopoFoto
  const riep = await redis.getdel(`igriep:${id}`);
  const p = await redis.get<Post>(`igpost:${id}`);
  // Se arriva la domanda ✍️ il conteggio c'è già lì dentro
  if (riep && p && !(p.serveDidascalia && !p.didascaliaScritta)) {
    const n = (await slides(id, p)).length;
    const nv = await redis.hlen(kVid(id));
    const v = nv ? ` (${nv} video${MODO === "facebook" ? ", su Facebook escono solo le foto" : ""})` : "";
    await tg("sendMessage", { chat_id: chatId, text: `✅ Caricamento finito: ora ${n} slide${v}. Puoi pubblicare.` }).catch(() => {});
  }
  await chiediDidascalia(id, chatId);
}

// Foto in risposta alla copertina (o nello stesso album di una che lo è): aggiunta al carosello.
// Ritorna true se il messaggio era per un carosello, così il chiamante non lo tratta come altro.
// Video nei caroselli manuali (2026-10-17). Limiti: Telegram fa scaricare ai bot file fino a 20 MB,
// Instagram vuole video da 3 a 60 secondi nei caroselli. Il video sta su Vercel Blob (le funzioni Vercel non
// rispondono oltre 4,5 MB) e si cancella dopo la pubblicazione o lo scarto. Facebook: un post da API non mischia
// foto e video, quindi su Facebook escono solo le foto (scelta dell'admin).
export const MAX_VIDEO_MB = 20;
export interface Video {
  durata: number;
  byte?: number;
  larghezza?: number;
  altezza?: number;
}

// Nei caroselli Instagram accetta video da 4:5 a 1.91:1. Un video da telefono (9:16) dava errore 2207082 e il post
// usciva solo su Facebook (U14 volley, 2026-10-18). Fuori formato, o formato ignoto: si porta a 4:5 con bande nere.
const formatoOk = (v: Video) => !!v.larghezza && !!v.altezza && v.larghezza / v.altezza >= 0.8 && v.larghezza / v.altezza <= 1.91;
export async function videoPerCarosello(file: Buffer, v: Video): Promise<Buffer> {
  if (formatoOk(v)) return file;
  const base = join(tmpdir(), `v-${crypto.randomUUID()}`);
  await writeFile(`${base}.in`, file);
  try {
    await promisify(execFile)(ffmpeg as unknown as string, [
      "-y", "-loglevel", "error", "-i", `${base}.in`,
      "-vf", "scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30", "-b:v", "3500k",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", `${base}.mp4`,
    ], { timeout: 200_000 });
    return await readFile(`${base}.mp4`);
  } finally {
    await Promise.all([unlink(`${base}.in`).catch(() => {}), unlink(`${base}.mp4`).catch(() => {})]);
  }
}
const kVid = (id: string) => `igvid:${id}`; // hash: indice slide -> URL pubblico del video
const urlVideo = (id: string, k: number) => redis.hget<string>(kVid(id), String(k));

async function cancellaVideo(id: string, solo?: string) {
  const tutti = (await redis.hgetall<Record<string, string>>(kVid(id))) || {};
  const voci = Object.entries(tutti).filter(([k]) => solo === undefined || k === solo);
  if (!voci.length) return;
  await del(voci.map(([, u]) => u)).catch((e) => console.error("cancellaVideo", e));
  if (solo === undefined) await redis.del(kVid(id));
  else await redis.hdel(kVid(id), solo);
}

export async function aggiungiFoto(m: any, fileId: string, scarica: (id: string) => Promise<Buffer>, video?: Video): Promise<boolean> {
  const chat = m.chat.id;
  let id = m.reply_to_message ? await redis.get<string>(`igcover:${chat}:${m.reply_to_message.message_id}`) : null;
  if (m.media_group_id) {
    if (id) await redis.set(`igalb:${m.media_group_id}`, id, { ex: 600 });
    else {
      // Album: non tutte le foto portano la risposta, e arrivano in parallelo
      for (let i = 0; i < 4 && !id; i++) {
        id = await redis.get<string>(`igalb:${m.media_group_id}`);
        if (!id) await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
  }
  if (!id) return false;

  const rispondi = (text: string) =>
    tg("sendMessage", { chat_id: chat, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  // Post già chiuso: solo un avviso, il messaggio prosegue normalmente (l'admin 2026-10-11: non deve bloccare).
  // In coda invece si possono ancora aggiungere foto e video (2026-10-17)
  const lucchetto = await redis.get(`iglock:${id}`);
  if (lucchetto !== null && String(lucchetto) !== IN_CODA) {
    await rispondi("⚠️ Questo carosello è già pubblicato o scartato: la foto non viene aggiunta lì.");
    return false;
  }
  // Post automatici (risultati, partite) e post nati prima della 1.8.0 non hanno l'ordine delle slide salvato:
  // le slide esistenti restano prime, la nuova va in fondo e prende un indice libero (2026-10-17)
  if (!(await redis.exists(`igord:${id}`))) {
    const n0 = (await redis.get<Post>(`igpost:${id}`))?.n ?? 1;
    for (let i = 0; i < n0; i++) await redis.zadd(`igord:${id}`, { score: i - n0 - 1e12, member: String(i) });
    await redis.expire(`igord:${id}`, TTL);
    await redis.set(`ignext:${id}`, n0, { nx: true, ex: TTL });
  }
  if ((await redis.zcard(`igord:${id}`)) >= MAX_SLIDE) {
    await rispondi(`Massimo ${MAX_SLIDE} slide su Instagram: questa slide non è stata aggiunta.`);
    return true;
  }
  if (video?.byte && video.byte > MAX_VIDEO_MB * 1_048_576) {
    await rispondi(`⚠️ Video troppo pesante (${Math.round(video.byte / 1_048_576)} MB), il massimo è ${MAX_VIDEO_MB} MB. Mandalo come video e non come file: Telegram lo comprime.`);
    return true;
  }
  if (video && (video.durata < 3 || video.durata > 60)) {
    await rispondi(`⚠️ Video di ${video.durata} secondi: nei caroselli Instagram accetta video da 3 a 60 secondi. Taglialo e rimandalo.`);
    return true;
  }
  // Conferma subito (2026-10-13): 👀 sulla foto appena arriva, 👍 quando è pronta. Le foto in lavorazione si contano
  // (igin) e il riepilogo si riscrive una volta sola, quando finisce l'ultima: con un album le modifiche insieme
  // facevano frenare Telegram ("retry after") e allungavano l'attesa.
  const reazione = (emoji?: string) =>
    tg("setMessageReaction", { chat_id: chat, message_id: m.message_id, reaction: emoji ? [{ type: "emoji", emoji }] : [] }).catch(() => {});
  await reazione("👀");
  if ((await redis.incr(`igin:${id}`)) === 1) await aggiornaManuale(id);
  await redis.expire(`igin:${id}`, 600);
  let aggiunta = false;
  try {
    const file = await scarica(fileId);
    // Il video non si ritaglia: Instagram lo adatta da solo alla forma del carosello
    const { img, avviso } = video ? { img: undefined, avviso: undefined } : await ritaglia45(file);
    const k = await redis.incr(`ignext:${id}`) - 1;
    await redis.zadd(`igord:${id}`, { score: m.message_id, member: String(k) });
    // Le foto di un album arrivano in parallelo: il controllo sopra non basta, si ricontrolla dopo l'aggiunta
    if ((await redis.zcard(`igord:${id}`)) > MAX_SLIDE) {
      await redis.zrem(`igord:${id}`, String(k));
      await rispondi(`Massimo ${MAX_SLIDE} slide su Instagram: questa foto non è stata aggiunta.`);
      return true;
    }
    if (img) await redis.set(`igimg:${id}:${k}`, img.toString("base64"), { ex: TTL });
    else {
      const b = await put(`video/${id}-${k}.mp4`, await videoPerCarosello(file, video!), { access: "public", addRandomSuffix: true, contentType: "video/mp4" });
      await redis.hset(kVid(id), { [k]: b.url });
      await redis.expire(kVid(id), TTL);
    }
    const pos = (await redis.zrank(`igord:${id}`, String(k))) ?? 0;
    if (avviso) await redis.hset(`igavv:${id}`, { [k]: `foto ${pos + 1}: ${avviso}` });
    await redis.expire(`igavv:${id}`, TTL);
    aggiunta = true;
  } catch (e) {
    console.error("aggiungiFoto", e);
    await rispondi(video ? "⚠️ Questo video non è stato aggiunto, rimandalo." : "⚠️ Questa foto non è stata aggiunta, rimandala.");
  } finally {
    await reazione(aggiunta ? "👍" : undefined);
    // Riepilogo solo quando non resta nessuna foto in lavorazione: l'ultima a finire lo scrive con tutto dentro
    if ((await redis.decr(`igin:${id}`)) <= 0) {
      await redis.del(`igin:${id}`);
      await aggiornaManuale(id);
    }
  }
  if (aggiunta) {
    // Un solo riepilogo a fine caricamento, non uno per foto (2026-10-25): lo manda dopoFoto
    await redis.set(`igriep:${id}`, 1, { ex: 3600 });
    await aggiornaMsgFoto(id);
  }
  await dopoFoto(id, chat);
  return true;
}

// Risposta alla domanda "✍️ Scrivi la didascalia" (post manuali ed eventi). Si può riscrivere finché il post
// non è pubblicato o scartato: vale l'ultima. true = messaggio gestito, il chiamante non fa altro.
export async function suDidascalia(m: any): Promise<boolean> {
  const rif = m.reply_to_message?.message_id;
  if (!rif) return false;
  // Risposta a 🗣 Spiego io: si aggiunge allo spunto e si rifà la bozza
  const daSpiegare = await redis.get<string>(`igspiega:${m.chat.id}:${rif}`);
  if (daSpiegare && m.text && !m.text.startsWith("/")) {
    const spunto = (await redis.get<string>(`igspunto:${daSpiegare}`)) || "";
    await redis.set(`igspunto:${daSpiegare}`, `${spunto.split("\nRacconto di chi era lì")[0]}
Racconto di chi era lì (usalo come base, puoi citarlo): ${m.text.trim()}`, { ex: TTL });
    await tg("editMessageText", { chat_id: m.chat.id, message_id: rif, text: "✅ Ricevuto, riscrivo la bozza ⏳" }).catch(() => {});
    await mandaBozza(daSpiegare, m.chat.id, true);
    return true;
  }
  const id = await redis.get<string>(`igdid:${m.chat.id}:${rif}`);
  if (!id) return false;
  const testo = String(m.text || "").trim();
  if (testo.startsWith("/")) return false; // comandi (es. /annulla): non sono didascalie
  if (m.photo || m.document || m.video) return false; // una foto qui va nel carosello (aggiungiFoto), non è una didascalia
  const rispondi = (text: string) =>
    tg("sendMessage", { chat_id: m.chat.id, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  if (!testo) {
    await rispondi("Qui serve il testo della didascalia. Le foto vanno in risposta alla copertina.");
    return true;
  }
  // In coda la didascalia si può ancora cambiare; pubblicato o scartato no
  const lucchetto = await redis.get(`iglock:${id}`);
  const inCoda = String(lucchetto) === IN_CODA;
  if (lucchetto !== null && !inCoda) {
    // Solo avviso: il testo prosegue (es. risposta a una domanda di /evento), non blocca (2026-10-11)
    await rispondi("⚠️ Questo post è già pubblicato o scartato: la didascalia non cambia più.");
    return false;
  }
  // 3.0: risposta alla scheda = materiale per il testo del post (anche una cronaca più lunga di una didascalia)
  const schedaMsg = await redis.get<Msg>(`igmsg:${id}`);
  if (v3(m.chat.id) && schedaMsg?.message_id === rif) {
    const p3 = await redis.get<Post>(`igpost:${id}`);
    if (!p3) {
      await rispondi("Post scaduto (7 giorni): rifai la grafica.");
      return true;
    }
    await testoDallaScheda(id, p3, testo.slice(0, 4000), m);
    return true;
  }
  if (testo.length > MAX_DIDASCALIA) {
    await rispondi(`Didascalia troppo lunga: ${testo.length} caratteri, Instagram ne accetta ${MAX_DIDASCALIA}. Accorciala e rimandala.`);
    return true;
  }
  const hashtag = (testo.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (hashtag > MAX_HASHTAG) {
    await rispondi(`Troppi hashtag: ${hashtag}, Instagram ne accetta ${MAX_HASHTAG}. Togline qualcuno e rimandala.`);
    return true;
  }
  const p = await redis.get<Post>(`igpost:${id}`);
  if (!p) {
    await rispondi("Post scaduto (7 giorni): rifai la grafica.");
    return true;
  }
  // Evento: la prima risposta alla domanda sono i punti chiave, non la didascalia
  const bozmsg0 = await redis.get<Msg>(`igbozmsg:${id}`);
  // Didascalia già completa (hashtag o testo lungo): è manuale, si salva così com'è (2026-10-25)
  const completa = !!(await redis.get(`igmanuale:${m.chat.id}:${rif}`)) || /#[\p{L}\p{N}_]+/u.test(testo) || testo.length >= 250;
  if (p.evento && !p.puntiDati && bozmsg0?.message_id !== rif && !completa) {
    await redis.set<Post>(`igpost:${id}`, { ...p, puntiDati: true }, { keepTtl: true });
    await redis.set(`igspunto:${id}`, `EVENTO\nTitolo grafica: ${p.caption}\nPunti chiave: ${testo}`, { ex: TTL });
    await tg("editMessageText", { chat_id: m.chat.id, message_id: rif, text: "✅ Punti ricevuti. Sotto la bozza: ✅ per usarla, oppure rispondi alla bozza col testo giusto." }).catch(() => {});
    await mandaBozza(id, m.chat.id, true);
    return true;
  }
  // Risposta alla bozza AI: il messaggio della bozza resta, si tolgono solo i bottoni
  const bozmsg = await redis.get<Msg>(`igbozmsg:${id}`);
  if (bozmsg?.message_id === rif) await tg("editMessageReplyMarkup", { ...bozmsg, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  else await tg("editMessageText", { chat_id: m.chat.id, message_id: rif, text: "✅ Didascalia salvata. Per cambiarla rispondi di nuovo a questo messaggio." }).catch(() => {});
  await ricordaDidascalia(testo).catch(() => {}); // scritta da una persona: esempio per le prossime bozze
  await salvaDidascalia(id, p, testo, m.chat.id, m.message_id, inCoda);
  return true;
}

async function salvaDidascalia(id: string, p: Post, testo: string, chat: number, rispostaA: number, inCoda: boolean) {
  const m = { chat: { id: chat }, message_id: rispostaA };
  await redis.set<Post>(`igpost:${id}`, { ...p, caption: testo, didascaliaScritta: true }, { keepTtl: true });
  if (inCoda) await aggiornaCoda();
  else if (!(await redis.exists(`igcop:${id}`))) {
    // Post automatico (risultati, partite) cambiato con ✏️: il suo messaggio resta com'è
    await tg("sendMessage", { chat_id: m.chat.id, text: "✅ Didascalia aggiornata.", reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }).catch(() => {});
  } else {
    await aggiornaManuale(id);
    // Conferma in fondo al gruppo con i bottoni a portata di mano: il messaggio del carosello sta molto più in alto
    // e dopo la didascalia non si capiva cosa fare (2026-10-11)
    await tg("sendMessage", {
      chat_id: m.chat.id,
      text: "✅ Didascalia salvata. Ora premi ✅ Pubblica: il post va in coda per Instagram e Facebook.\nPer cambiarla rispondi di nuovo alla domanda ✍️.",
      reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: "✅ Pubblica", callback_data: `ig:${id}` }, { text: "❌ Scarta", callback_data: `igx:${id}` }]] },
    }).catch(() => {});
  }
}

// 🗑 Togli ultima: la foto aggiunta per ultima (la copertina non si toglie)
export async function suTogliUltima(q: any) {
  const id = String(q.data).slice(6);
  const lucchettoDel = await redis.get(`iglock:${id}`);
  if (lucchettoDel !== null && String(lucchettoDel) !== IN_CODA) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Già pubblicato o scartato.", show_alert: true });
    return;
  }
  const ultime = await redis.zrange<string[]>(`igord:${id}`, -1, -1, { withScores: true });
  // Si tolgono solo foto e video aggiunti (punteggio = id del messaggio, positivo): copertina e slide create dal bot restano
  if ((await redis.zcard(`igord:${id}`)) <= 1 || !ultime.length || Number(ultime[1]) <= 0) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Nessuna foto aggiunta da togliere: le slide del bot restano." });
    return;
  }
  const k = ultime[0];
  await redis.zrem(`igord:${id}`, k);
  await redis.hdel(`igavv:${id}`, k);
  await redis.del(`igimg:${id}:${k}`);
  await cancellaVideo(id, String(k));
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Ultima foto o video tolto." });
  await aggiornaMsgFoto(id);
  await aggiornaManuale(id);
}

// ❌ Annulla / Scarta: chiunque nel gruppo. Il lucchetto blocca anche la pubblicazione programmata.
export async function suAnnullaInstagram(q: any) {
  const id = String(q.data).slice(4);
  const chi = q.from.first_name || q.from.username || "qualcuno";
  if (!(await redis.set(`iglock:${id}`, "annullato", { nx: true, ex: TTL }))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Già pubblicato o già annullato.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  await tg("editMessageText", {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text: `❌ Annullato da ${chi}. Non verrà pubblicato.`,
  }).catch(() => {});
  await cancellaVideo(id);
}

// Chiamata da QStash allo scadere dell'attesa (api/ig-auto.ts)
export async function pubblicaProgrammato(id: string) {
  if (!(await redis.getdel(`igauto:${id}`))) return; // mai programmato come automatico
  const msg = await redis.get<Msg>(`igmsg:${id}`);
  const [t, p] = await Promise.all([redis.get<Token>("ig:token"), redis.get<Post>(`igpost:${id}`)]);
  if (!msg || !t || !p) return;
  // Annullato, o già messo in coda con "✅ In coda subito": il lucchetto c'è già
  if (!(await redis.set(`iglock:${id}`, IN_CODA, { nx: true, ex: TTL }))) return;
  await accoda(id, "il bot (nessuno ha annullato)");
}

// ---- Coda di pubblicazione (2026-10-11): il ✅ non pubblica subito, mette in coda ----
// Calendario: tra due uscite passano almeno INTERVALLO_ORE ore, di notte non esce niente
// (un orario che cade tra NOTTE_DA e NOTTE_A slitta alle NOTTE_A). Ordine = ordine dei ✅.
// Il giro della coda lo fa QStash (api/ig-auto?coda=1) all'orario previsto: Vercel gratuito non ha cron frequenti.
// Ogni giro pubblica il primo se è il suo momento, poi programma il giro successivo.
const INTERVALLO_ORE = 2; // l'admin 2026-10-11: ogni 2 ore, mai tra le 23 e le 8
const NOTTE_DA = 23;
const NOTTE_A = 8;
const ORA_MS = 3_600_000;
const PRE = process.env.IG_CODA_PREFIX || "igcoda"; // le prove usano un prefisso loro, mai la coda vera
const CODA = PRE; // sorted set: id -> momento del ✅
const ULTIMA = `${PRE}:ultima`; // ms dell'ultima uscita
const PAUSA = `${PRE}:pausa`; // ms prima dei quali non si riprova (dopo un errore Meta)
const GIRO = `${PRE}:giro`; // lucchetto del giro
const IN_CODA = "coda"; // valore di iglock:<id> mentre il post aspetta il suo turno

const breveTesto = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");
const quando = (ms: number) =>
  new Date(ms).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });

function oraRoma(ms: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { h: Number(p.hour), m: Number(p.minute) };
}

// Orario fuori dalla notte: se cade di notte, le NOTTE_A successive (ricontrollo per i cambi d'ora)
export function fuoriNotte(ms: number): number {
  for (let i = 0; i < 3; i++) {
    const { h, m } = oraRoma(ms);
    const min = h >= NOTTE_DA ? (24 - h + NOTTE_A) * 60 - m : h < NOTTE_A ? (NOTTE_A - h) * 60 - m : 0;
    if (!min) return ms;
    ms += min * 60_000;
    ms -= ms % 60_000;
  }
  return ms;
}

// Primo orario utile per un'uscita: 7 ore dopo l'ultima, fuori dalla notte e dalla pausa dopo un errore
async function primoLibero(adesso = Date.now()): Promise<number> {
  const [ultima, pausa] = await Promise.all([redis.get<number>(ULTIMA), redis.get<number>(PAUSA)]);
  return fuoriNotte(Math.max(adesso, ultima ? Number(ultima) + INTERVALLO_ORE * ORA_MS : 0, pausa ? Number(pausa) : 0));
}

// Quando uscirebbe un post messo in coda adesso, in fondo alla coda attuale
async function uscitaInCoda(entra: number): Promise<number> {
  const prev = await previsioni(entra);
  return prev.length ? fuoriNotte(prev[prev.length - 1].ms + INTERVALLO_ORE * ORA_MS) : primoLibero(entra);
}

export async function previsioni(adesso = Date.now()): Promise<{ id: string; ms: number }[]> {
  const ids = await redis.zrange<string[]>(CODA, 0, -1);
  let t = await primoLibero(adesso);
  const out: { id: string; ms: number }[] = [];
  for (const id of ids) {
    out.push({ id, ms: t });
    t = fuoriNotte(t + INTERVALLO_ORE * ORA_MS);
  }
  return out;
}

// Messaggi di tutti i post in coda: posizione e orario previsto (cambiano quando la coda cambia)
export async function aggiornaCoda() {
  const prev = await previsioni();
  for (const [i, { id, ms }] of prev.entries()) {
    const [msg, chi, p] = await Promise.all([redis.get<Msg>(`igmsg:${id}`), redis.get<string>(`igchi:${id}`), redis.get<Post>(`igpost:${id}`)]);
    if (!msg) continue;
    await allunga(id, ms);
    // Rispondendo al messaggio della coda si aggiungono foto e video, per ogni post (vale anche per quelli già in coda)
    await redis.set(`igcover:${msg.chat_id}:${msg.message_id}`, id, { ex: Math.max(TTL, Math.ceil((ms - Date.now()) / 1000) + 2 * 86_400) });
    const righe = [
      `🗓 In coda per ${DOVE}: ${i + 1}° su ${prev.length}`,
      `Uscita prevista: ${quando(ms)}`,
      ...(chi ? [`Messo in coda da ${chi}`] : []),
      ...(p ? [`📝 Didascalia: ${breveTesto(p.caption)}`] : []),
      // Foto e video si aggiungono anche in coda (2026-10-17)
      ...(p ? [`🖼 ${(await slides(id, p)).length}/${MAX_SLIDE} slide${(await redis.hlen(kVid(id))) ? `, di cui ${await redis.hlen(kVid(id))} video${MODO === "facebook" ? " (su Facebook escono solo le foto)" : ""}` : ""}. Rispondi a questo messaggio con foto o video per aggiungerli.`] : []),
    ];
    await tg("editMessageText", {
      ...msg,
      text: righe.join("\n"),
      reply_markup: {
        inline_keyboard: [
          [{ text: "❌ Togli dalla coda", callback_data: `igcx:${id}` }, { text: "⚡ Pubblica subito", callback_data: `igcn:${id}` }],
          bottoniModifica(id),
        ],
      },
    }).catch(() => {});
  }
}

// Un post in coda può aspettare più dei 7 giorni di vita delle immagini: si allungano fino a 2 giorni dopo l'uscita
async function allunga(id: string, finoA: number) {
  const ex = Math.ceil((finoA - Date.now()) / 1000) + 2 * 86_400;
  if ((await redis.ttl(`igpost:${id}`)) >= ex) return;
  const p = await redis.get<Post>(`igpost:${id}`);
  if (!p) return;
  const chiavi = ["igpost", "igmsg", "igord", "igavv", "igprob", "igchi", "iglock", "igvid"].map((k) => `${k}:${id}`);
  for (const k of await slides(id, p)) chiavi.push(`igimg:${id}:${k}`);
  for (const k of chiavi) await redis.expire(k, ex);
}

// Giro della coda all'orario del primo. Deduplicato per orario: più richieste uguali = un giro solo.
async function programmaGiro() {
  const prev = await previsioni();
  if (!prev.length) return;
  const sec = Math.floor(prev[0].ms / 1000);
  const dest = `${process.env.BASE_URL}/api/ig-auto?coda=1`;
  const r = await fetch(`${process.env.QSTASH_URL || "https://qstash.upstash.io"}/v2/publish/${dest}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      "Upstash-Not-Before": String(sec),
      "Upstash-Deduplication-Id": `${PRE}-${sec}`,
      "Upstash-Retries": "2",
    },
  });
  if (!r.ok) await avvisaAdmin(`⚠️ Coda ${DOVE}: giro delle ${quando(prev[0].ms)} non programmato (QStash ${r.status}). Il prossimo ✅ lo riprogramma.`);
}

// Il post entra in coda. Il chiamante ha già messo iglock = IN_CODA.
async function accoda(id: string, chi: string) {
  await redis.zadd(CODA, { score: Date.now(), member: id });
  await redis.set(`igchi:${id}`, chi, { ex: TTL });
  await redis.set(`igcodats:${id}`, Date.now(), { ex: TTL });
  await aggiornaCoda();
  await programmaGiro();
}

// ---- Avvisi nel Generale del gruppo (2026-10-17) ----
// Un post che non esce lo dice in Generale, non solo nel suo argomento. Quando la coda si svuota arriva il
// riepilogo dei post del giro: usciti, usciti a metà, non usciti.
const USCITI = `${PRE}:usciti`; // lista di righe del riepilogo, dall'ultima volta che la coda era vuota
const titoloPost = (p?: Post | null) => breveTesto((p?.caption || "post senza didascalia").split("\n")[0], 60);

async function generale(chatId: number, text: string) {
  // 3.0: gli errori vanno nell'argomento ⚠️ ERRORI (chiuso: scrivono bot e amministratori), il Generale è chiuso
  const errori = v3(chatId) && text.startsWith("⚠️") ? await idArgomento("errori", chatId) : undefined;
  if (text.startsWith("⚠️") && !inProva(chatId)) await registraErrore(text, "gruppo");
  // nelThread(undefined): fuori da qualsiasi argomento, cioè nel Generale
  await nelThread(errori, () => tg("sendMessage", { chat_id: chatId, text })).catch((e) => console.error("generale", e));
}

async function registraEsito(riga: string) {
  await redis.rpush(USCITI, riga);
  await redis.expire(USCITI, 14 * 86_400);
}

async function riepilogoSeFinita(chatId: number) {
  if (await redis.zcard(CODA)) return;
  const righe = await redis.lrange<string>(USCITI, 0, -1);
  if (!righe.length) return;
  await redis.del(USCITI);
  await generale(chatId, `🗓 Coda finita. Post di questo giro:\n${righe.join("\n")}`);
  // 3.0: coda finita senza errori = pulizia di ✍️ Post manuali, se non c'è lavoro in corso (lib/reset.ts)
  if (v3(chatId) && righe.every((r) => r.startsWith("✅"))) await (await import("./reset")).resetSePossibile(chatId).catch((e) => console.error("reset", e));
}

// Chiamata da QStash (api/ig-auto?coda=1): pubblica il primo se è il suo momento
export async function giraCoda() {
  if (!(await redis.set(GIRO, 1, { nx: true, ex: 600 }))) return;
  try {
    for (;;) {
      const prev = await previsioni();
      if (!prev.length || prev[0].ms > Date.now() + 60_000) return;
      const { id } = prev[0];
      if (!(await redis.zrem(CODA, id))) continue; // tolto o pubblicato da un altro nel frattempo
      const [msg, t, p] = await Promise.all([redis.get<Msg>(`igmsg:${id}`), redis.get<Token>("ig:token"), redis.get<Post>(`igpost:${id}`)]);
      if (!msg || !t || !p) {
        await redis.set(`iglock:${id}`, "scaduto", { ex: TTL });
        if (msg) await tg("editMessageText", { ...msg, text: `⚠️ ${t ? "Post scaduto" : "Instagram non collegato"}: non pubblicato.` }).catch(() => {});
        await avvisaAdmin(`⚠️ Coda: post ${id} saltato (${!t ? "Instagram non collegato" : "immagini scadute"}).`);
        if (msg) {
          const motivo = t ? "il post è scaduto (immagini più vecchie di 7 giorni)" : "Instagram non è collegato";
          await generale(msg.chat_id, `⚠️ Post non pubblicato: «${titoloPost(p)}».\nMotivo: ${motivo}.`);
          await registraEsito(`❌ ${titoloPost(p)}: non pubblicato`);
          await riepilogoSeFinita(msg.chat_id);
        }
        continue;
      }
      await redis.set(`iglock:${id}`, 1, { ex: TTL });
      if (await esegui(id, t, p, msg)) {
        await redis.set(ULTIMA, Date.now());
      } else {
        // Niente uscito (Meta giù?): il post torna al ✅ "Riprova", la coda aspetta un'ora prima del prossimo
        await redis.set(PAUSA, Date.now() + ORA_MS, { ex: 2 * 3600 });
      }
      await aggiornaCoda();
      await riepilogoSeFinita(msg.chat_id);
      return;
    }
  } finally {
    await redis.del(GIRO);
    await programmaGiro();
  }
}

// ⚡ Pubblica subito: salta la coda (urgenze). Il prossimo esce INTERVALLO_ORE dopo questo.
export async function suPubblicaSubito(q: any) {
  const id = String(q.data).slice(5);
  if (!(await redis.zrem(CODA, id))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Non è più in coda.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const msg: Msg = { chat_id: q.message.chat.id, message_id: q.message.message_id };
  const [t, p] = await Promise.all([redis.get<Token>("ig:token"), redis.get<Post>(`igpost:${id}`)]);
  if (!t || !p) {
    await redis.set(`iglock:${id}`, "scaduto", { ex: TTL });
    await tg("editMessageText", { ...msg, text: `⚠️ ${t ? "Post scaduto" : "Instagram non collegato"}: non pubblicato.` }).catch(() => {});
    await generale(msg.chat_id, `⚠️ Post non pubblicato: «${titoloPost(p)}».\nMotivo: ${t ? "il post è scaduto" : "Instagram non è collegato"}.`);
    await registraEsito(`❌ ${titoloPost(p)}: non pubblicato`);
  } else {
    await redis.set(`iglock:${id}`, 1, { ex: TTL });
    if (await esegui(id, t, p, msg)) await redis.set(ULTIMA, Date.now());
  }
  await aggiornaCoda();
  await riepilogoSeFinita(msg.chat_id);
  await programmaGiro();
}

// ❌ Togli dalla coda: non verrà pubblicato
export async function suTogliDallaCoda(q: any) {
  const id = String(q.data).slice(5);
  const chi = q.from.first_name || q.from.username || "qualcuno";
  if (!(await redis.zrem(CODA, id))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Non è più in coda.", show_alert: true });
    return;
  }
  await redis.set(`iglock:${id}`, "annullato", { ex: TTL });
  await cancellaVideo(id);
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `❌ Tolto dalla coda da ${chi}. Non verrà pubblicato.` }).catch(() => {});
  await aggiornaCoda();
  await programmaGiro();
}

// /coda: elenco con gli orari previsti
export const postInCoda = () => redis.zcard(CODA);

export async function elencoCoda(): Promise<string> {
  const prev = await previsioni();
  if (!prev.length) {
    const prossimo = await primoLibero();
    return prossimo <= Date.now() + 60_000 ? "🗓 Coda vuota: il prossimo ✅ esce subito." : `🗓 Coda vuota: il prossimo ✅ esce ${quando(prossimo)}.`;
  }
  const righe = [`🗓 In coda per ${DOVE} (uno ogni ${INTERVALLO_ORE} ore, mai tra le ${NOTTE_DA} e le ${NOTTE_A}):`];
  for (const [i, { id, ms }] of prev.entries()) {
    const p = await redis.get<Post>(`igpost:${id}`);
    righe.push(`${i + 1}. ${quando(ms)} · ${breveTesto((p?.caption || "").split("\n")[0], 40)}`);
  }
  return righe.join("\n");
}

// Immagine servita a Instagram/Facebook, chiave "id:indice"
export async function immagine(chiave: string): Promise<Buffer | null> {
  if (!/^[\w-]+:\d+$/.test(chiave)) return null;
  const b = await redis.get<string>(`igimg:${chiave}`);
  return b ? Buffer.from(b, "base64") : null;
}

const urlImg = (id: string, i: number) => `${process.env.BASE_URL}/api/instagram?img=${id}:${i}`;

// Instagram elabora il container in modo asincrono: si pubblica solo a FINISHED
// Foto: pronte in pochi secondi (20 tentativi). Video: Instagram li elabora, fino a 3 minuti (60 tentativi)
async function attendiPronto(base: string, container: string, token: string, tentativi = 20) {
  for (let i = 0; i < tentativi; i++) {
    const { status_code } = await graph<{ status_code: string }>(`${base}/${container}`, { fields: "status_code", access_token: token });
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Instagram: container ${status_code}`);
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  throw new Error(`Instagram: container non pronto dopo ${tentativi * 3} secondi`);
}

// Pubblica su Instagram, ritorna il link del post
async function pubblicaIg(id: string, t: Token, p: Post): Promise<string> {
  const crea = (params: Record<string, string>) =>
    graph<{ id: string }>(`${graphDi(t)}/${t.igUserId}/media`, { ...params, access_token: t.token }, "POST").then((r) => r.id);
  const ks = await slides(id, p);
  // Hashtag nel primo commento, didascalia più corta (Issue 6). Solo se il login ha dato il permesso dei commenti:
  // senza, Meta rifiuta il commento (#10) e il post usciva senza hashtag (2/11). Allora didascalia intera.
  const commenti = !!t.permessi?.includes("instagram_manage_comments");
  const diviso = dividiHashtag(p.caption);
  const { testo, hashtag } = commenti ? diviso : { testo: p.caption, hashtag: "" };
  let container: string;
  // Tag delle avversarie sulla slide originale k (Issue 10). Se Meta rifiuta i tag, la slide esce senza
  // Rifiutati: si controlla account per account, gli errori si sommano per squadra e dopo 2 l'account si toglie e si
  // richiede (lib/account.ts). Si riprova con i tag buoni, poi senza. Avviso solo quando un account viene tolto.
  const creaConTag = async (params: Record<string, string>, k: number) => {
    const tag: Tag[] = p.avversari?.[k] ? await tagSlide(p.avversari[k]).catch(() => []) : [];
    if (!tag.length) return crea(params);
    try {
      return await crea({ ...params, user_tags: perMeta(tag) });
    } catch {
      const { buoni, tolti } = await gestisciTagRifiutati(tag).catch(() => ({ buoni: [] as Tag[], tolti: [] as string[] }));
      if (tolti.length) await avvisaAdmin(`⚠️ Instagram: tag rifiutato due volte, account tolto e richiesto: ${tolti.join(", ")}`);
      if (buoni.length && buoni.length < tag.length) {
        const c = await crea({ ...params, user_tags: perMeta(buoni) }).catch(() => null);
        if (c) return c;
      }
      return crea(params);
    }
  };
  if (ks.length === 1) container = await creaConTag({ image_url: urlImg(id, ks[0]), caption: testo, ...(p.alt ? { alt_text: p.alt } : {}) }, Number(ks[0]));
  else {
    const figli: string[] = [];
    for (const k of ks) {
      const video = await urlVideo(id, k);
      if (!video) {
        figli.push(await creaConTag({ image_url: urlImg(id, k), is_carousel_item: "true" }, Number(k)));
        continue;
      }
      // Video: Instagram lo scarica da Vercel Blob e lo elabora; il carosello si crea solo con figli pronti
      const c = await crea({ media_type: "VIDEO", video_url: video, is_carousel_item: "true" });
      await attendiPronto(graphDi(t), c, t.token, 60);
      figli.push(c);
    }
    container = await crea({ media_type: "CAROUSEL", children: figli.join(","), caption: testo });
  }
  await attendiPronto(graphDi(t), container, t.token);
  const { id: media } = await graph<{ id: string }>(`${graphDi(t)}/${t.igUserId}/media_publish`, { creation_id: container, access_token: t.token }, "POST");
  await salvaIdSocial(id, "ig", media).catch((e) => console.error("registro ig", e));
  if (hashtag) await graph(`${graphDi(t)}/${media}/comments`, { message: hashtag, access_token: t.token }, "POST").catch((e) => avvisaAdmin(`⚠️ Instagram: post pubblicato ma gli hashtag nel commento no: ${(e as Error).message}`));
  return graph<{ permalink: string }>(`${graphDi(t)}/${media}`, { fields: "permalink", access_token: t.token })
    .then((r) => r.permalink)
    .catch(() => "");
}

// Storie (Issue 4): la copertina di un risultato esce anche nelle storie di Instagram.
// Dalla 3.11.0 anche amichevoli e tornei (l'admin 2/11).
const CON_STORIA = ["risultato", "amichevole", "torneo"];
// 9:16 = copertina intera al centro su sfondo sfocato della stessa foto. Indice 99 = immagine della storia in Redis.
const K_STORIA = 99;
export async function storiaDaCopertina(copertina: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const W = 1080;
  const H = 1920;
  const sfondo = await sharp(copertina).rotate().resize(W, H, { fit: "cover" }).blur(40).modulate({ brightness: 0.7 }).toBuffer();
  const centro = await sharp(copertina).rotate().resize({ width: W, height: H, fit: "inside" }).toBuffer();
  return sharp(sfondo).composite([{ input: centro, gravity: "centre" }]).jpeg({ quality: 90 }).toBuffer();
}

// Mai bloccante: se la storia non esce, il post è già uscito e basta un avviso all'admin.
async function pubblicaStoria(id: string, t: Token, p: Post): Promise<void> {
  if (!CON_STORIA.includes(p.tipo ?? "")) return;
  try {
    const [k] = await slides(id, p);
    const cop = await immagine(`${id}:${k}`);
    if (!cop) return;
    await redis.set(`igimg:${id}:${K_STORIA}`, (await storiaDaCopertina(cop)).toString("base64"), { ex: TTL });
    const { id: container } = await graph<{ id: string }>(
      `${graphDi(t)}/${t.igUserId}/media`,
      { media_type: "STORIES", image_url: urlImg(id, K_STORIA), access_token: t.token },
      "POST",
    );
    await attendiPronto(graphDi(t), container, t.token);
    await graph(`${graphDi(t)}/${t.igUserId}/media_publish`, { creation_id: container, access_token: t.token }, "POST");
  } catch (e) {
    await avvisaAdmin(`⚠️ Storia Instagram non pubblicata: ${(e as Error).message}`).catch(() => {});
  }
}

// Pubblica sulla Pagina Facebook: una foto, o più foto caricate non pubblicate e poi un post che le raccoglie
async function pubblicaFb(id: string, t: Token, p: Post): Promise<string> {
  const testoFb = conDomandaFb(p.caption, p.tipo); // domanda finale per far commentare (solo Facebook, solo risultati)
  // Solo le foto: un post Facebook da API non mischia foto e video (scelta dell'admin 2026-10-17)
  const video = new Set(Object.keys((await redis.hgetall<Record<string, string>>(kVid(id))) || {}));
  const ks = (await slides(id, p)).filter((k) => !video.has(String(k)));
  let postId: string;
  if (ks.length === 1) {
    const r = await graph<{ post_id?: string; id: string }>(
      `${GRAPH_FB}/${t.pageId}/photos`,
      { url: urlImg(id, ks[0]), caption: testoFb, access_token: t.token },
      "POST",
    );
    postId = r.post_id || r.id;
  } else {
    const foto: string[] = [];
    for (const k of ks) {
      const r = await graph<{ id: string }>(`${GRAPH_FB}/${t.pageId}/photos`, { url: urlImg(id, k), published: "false", access_token: t.token }, "POST");
      foto.push(r.id);
    }
    const params: Record<string, string> = { message: testoFb, access_token: t.token };
    foto.forEach((f, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: f })));
    postId = (await graph<{ id: string }>(`${GRAPH_FB}/${t.pageId}/feed`, params, "POST")).id;
  }
  await salvaIdSocial(id, "fb", postId).catch((e) => console.error("registro fb", e));
  return graph<{ permalink_url: string }>(`${GRAPH_FB}/${postId}`, { fields: "permalink_url", access_token: t.token })
    .then((r) => r.permalink_url)
    .catch(() => "");
}

// Tocco su "✅ Pubblica" / "✅ Pubblica ora"
export async function suBottoneInstagram(q: any) {
  const id = String(q.data).slice(3);
  const msg: Msg = { chat_id: q.message.chat.id, message_id: q.message.message_id };
  const [t, p] = await Promise.all([redis.get<Token>("ig:token"), redis.get<Post>(`igpost:${id}`)]);
  if (!t || !p) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: t ? "Bottone scaduto (7 giorni)." : "Instagram non collegato.", show_alert: true });
    return;
  }
  // Niente pubblicazione mentre le foto si stanno ancora caricando (2026-10-25)
  if (Number(await redis.get(`igin:${id}`)) > 0) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "⏳ Sto ancora caricando le foto. Aspetta il messaggio di fine caricamento e riprova.", show_alert: true });
    return;
  }
  if (p.serveDidascalia && !p.didascaliaScritta) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Prima scrivi la didascalia: rispondi al messaggio ✍️ sotto la copertina.", show_alert: true });
    return;
  }
  // Gruppo di prova: mai sui social e mai nella coda vera (è una sola per tutti i gruppi)
  if (inProva(msg.chat_id)) {
    if (!(await redis.set(`iglock:${id}`, "prova", { nx: true, ex: TTL }))) {
      await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Già fatto." });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🧪 Prova" });
    if (CON_STORIA.includes(p.tipo ?? "")) {
      // Niente Instagram: la storia si prepara e si mostra qui, con la stessa immagine che uscirebbe
      const [k] = await slides(id, p);
      const cop = await immagine(`${id}:${k}`);
      if (cop) {
        const storia = await storiaDaCopertina(cop);
        await redis.set(`igimg:${id}:${K_STORIA}`, storia.toString("base64"), { ex: TTL });
        await inviaFoto(msg.chat_id, storia, "🧪 PROVA: questa sarebbe la storia Instagram di oggi.").catch(() => {});
      }
    }
    const n = (await slides(id, p)).length;
    await tg("editMessageText", {
      ...msg,
      text: `🧪 PROVA: qui il post sarebbe andato in coda per ${DOVE}.\nUscita prevista: ${quando(await primoLibero())}\n🖼 ${n} slide\n\n📝 Testo:\n${p.caption}`,
    }).catch(() => {});
    return;
  }
  // Un solo tocco vale: il doppio clic, il secondo utente o il programmato trovano il lucchetto.
  // Il ✅ non pubblica: mette in coda, esce un post ogni INTERVALLO_ORE (2026-10-11).
  if (!(await redis.set(`iglock:${id}`, IN_CODA, { nx: true, ex: TTL }))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Già in coda, pubblicato o annullato." });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Messo in coda." });
  await redis.set<Msg>(`igmsg:${id}`, msg, { ex: TTL });
  // Foto e video in risposta al messaggio della coda vanno nel carosello (post manuali)
  if (await redis.exists(`igcop:${id}`)) await redis.set(`igcover:${msg.chat_id}:${msg.message_id}`, id, { ex: TTL });
  await accoda(id, q.from?.first_name || q.from?.username || "qualcuno");
}

// true = uscito almeno su un canale
async function esegui(id: string, t: Token, p: Post, msg: Msg): Promise<boolean> {
  // Login solo Instagram: Facebook lo fa (se lo fa) il crossposting di Instagram
  const soloIg = t.tipo !== "facebook";
  await tg("editMessageText", { ...msg, text: `⏳ Pubblico su ${soloIg ? "Instagram" : "Instagram e Facebook"}...` }).catch(() => {});
  const [ig, fb] = await Promise.allSettled([pubblicaIg(id, t, p), soloIg ? Promise.reject(new Error("solo Instagram")) : pubblicaFb(id, t, p)]);

  if (ig.status === "rejected" && fb.status === "rejected") {
    // Niente è uscito: si può riprovare senza rischio di doppioni
    await redis.del(`iglock:${id}`);
    await tg("editMessageText", {
      ...msg,
      text: "⚠️ Pubblicazione non riuscita. ✅ lo rimette in coda.",
      reply_markup: { inline_keyboard: [[{ text: "✅ Riprova", callback_data: `ig:${id}` }]] },
    }).catch(() => {});
    await avvisaAdmin(`❌ Pubblicazione, errori:\nInstagram: ${ig.reason}\nFacebook: ${fb.reason}`);
    await generale(msg.chat_id, `⚠️ Post non pubblicato: «${titoloPost(p)}».\nInstagram e Facebook non hanno risposto. Nel messaggio del post c'è ✅ Riprova.`);
    await registraEsito(`❌ ${titoloPost(p)}: non pubblicato, da riprovare`);
    return false;
  }
  // Almeno uno è uscito: niente nuovo tentativo completo, sarebbe un doppione.
  // Facebook uscito e Instagram no: si riprova da solo solo Instagram (l'admin 2026-10-18: UNDER 12 perso perché
  // Instagram non aveva finito il video in 3 minuti). I video restano su Vercel Blob finché Instagram non li prende.
  if (ig.status === "fulfilled") await pubblicaStoria(id, t, p);
  const riprova = ig.status === "rejected" && fb.status === "fulfilled" && (await programmaRiprovaIg(id, 1));
  if (!riprova) await cancellaVideo(id);
  const riga = (nome: string, r: PromiseSettledResult<string>) =>
    r.status === "fulfilled"
      ? `✅ ${nome} ${r.value}`.trim()
      : nome === "Instagram" && riprova
        ? `⏳ Instagram: non pronto, riprovo da solo tra ${RIPROVA_MIN} minuti`
        : `⚠️ ${nome}: non pubblicato, va fatto a mano`;
  const testo = soloIg ? riga("Instagram", ig) : `${riga("Instagram", ig)}\n${riga("Facebook", fb)}`;
  await tg("editMessageText", { ...msg, text: testo }).catch(() => {});
  const esiti = soloIg ? ([["Instagram", ig]] as const) : ([["Instagram", ig], ["Facebook", fb]] as const);
  for (const [nome, r] of esiti) {
    if (r.status === "rejected") await avvisaAdmin(`❌ ${nome}, errore:\n${(r.reason as Error).message}`);
  }
  const mancati = esiti.filter(([, r]) => r.status === "rejected").map(([nome]) => nome);
  await registra(id, p, { ig: ig.status === "fulfilled" ? ig.value : riprova ? undefined : false, fb: soloIg ? undefined : fb.status === "fulfilled" ? fb.value : false });
  const link = ig.status === "fulfilled" && ig.value ? ` ${ig.value}` : "";
  if (riprova) {
    await registraEsito(`⏳ ${titoloPost(p)}: Facebook uscito, Instagram in riprova`);
  } else if (mancati.length) {
    await generale(msg.chat_id, `⚠️ Post «${titoloPost(p)}» non pubblicato su ${mancati.join(" e ")}: va fatto a mano.`);
    await registraEsito(`⚠️ ${titoloPost(p)}: manca ${mancati.join(" e ")}${link}`);
  } else await registraEsito(`✅ ${titoloPost(p)}${link}`);
  return true;
}

// ---- Registro dei post pubblicati (2026-10-26) ----
// Mai bloccante: un errore qui non cambia l'esito della pubblicazione, arriva solo all'admin.
async function registra(id: string, p: Post, esito: { ig?: string | false; fb?: string | false }) {
  try {
    const [chi, inCoda, cron, bozza, video] = await Promise.all([
      redis.get<string>(`igchi:${id}`),
      redis.get<number>(`igcodats:${id}`),
      redis.exists(`igcron:${id}`),
      redis.get<string>(`igbozza:${id}`),
      redis.hlen(kVid(id)),
    ]);
    // Testo uscito uguale alla bozza = bozza (fatta sulla cronaca del coach se c'era); diverso = scritto da una persona
    const didascalia =
      p.auto && !p.didascaliaScritta ? "automatica" : bozza && p.caption.trim() === String(bozza).trim() ? (cron ? "cronaca del coach" : "bozza AI") : "scritta a mano";
    await registraPost(
      id,
      { tipo: p.tipo, categoria: p.categoria, ente: p.ente, automatico: !!p.auto, didascalia, slide: (await slides(id, p)).length, video, approvatoDa: chi || undefined, inCoda: inCoda || undefined },
      esito,
    );
  } catch (e) {
    await avvisaAdmin(`⚠️ Registro post: ${(e as Error).message}`).catch(() => {});
  }
}

// ---- Riprova solo Instagram (2026-10-18) ----
const RIPROVA_MIN = 15;
const RIPROVA_MAX = 3;

// Programma il tentativo n (QStash, api/ig-auto?soloig=<id>&n=<n>). false = tentativi finiti o QStash giù.
async function programmaRiprovaIg(id: string, n: number): Promise<boolean> {
  if (n > RIPROVA_MAX) return false;
  const dest = `${process.env.BASE_URL}/api/ig-auto?soloig=${id}&n=${n}`;
  const r = await fetch(`${process.env.QSTASH_URL || "https://qstash.upstash.io"}/v2/publish/${dest}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      "Upstash-Delay": `${RIPROVA_MIN}m`,
      "Upstash-Deduplication-Id": `soloig-${id}-${n}`,
      "Upstash-Retries": "0",
    },
  }).catch(() => null);
  return !!r?.ok;
}

export async function riprovaIg(id: string, n: number) {
  if (!(await redis.set(`igrip:${id}`, n, { nx: true, ex: 3600 }))) return; // stesso tentativo già in corso
  const [msg, t, p] = await Promise.all([redis.get<Msg>(`igmsg:${id}`), redis.get<Token>("ig:token"), redis.get<Post>(`igpost:${id}`)]);
  if (!msg || !t || !p) return;
  try {
    const link = await pubblicaIg(id, t, p);
    await pubblicaStoria(id, t, p);
    await registra(id, p, { ig: link });
    await cancellaVideo(id);
    await tg("editMessageText", { ...msg, text: `✅ Instagram ${link}\n✅ Facebook\nInstagram uscito al tentativo ${n + 1}.`.trim() }).catch(() => {});
    await generale(msg.chat_id, `✅ «${titoloPost(p)}» ora è anche su Instagram.${link ? ` ${link}` : ""}`);
  } catch (e) {
    await avvisaAdmin(`❌ Instagram, tentativo ${n + 1}:\n${(e as Error).message}`);
    await redis.del(`igrip:${id}`);
    if (await programmaRiprovaIg(id, n + 1)) return;
    await cancellaVideo(id);
    await tg("editMessageText", { ...msg, text: "✅ Facebook\n⚠️ Instagram: non pubblicato dopo 4 tentativi, va fatto a mano." }).catch(() => {});
    await generale(msg.chat_id, `⚠️ Post «${titoloPost(p)}» non pubblicato su Instagram dopo 4 tentativi: va fatto a mano.`);
  }
}

// Una tantum dopo un rilascio (2026-10-17): i post già esistenti e non pubblicati ricevono i bottoni nuovi
// (✏️ Modifica didascalia, 🖼 Modifica foto) e il collegamento per aggiungere foto rispondendo al loro messaggio.
export async function aggiornaPostAperti(): Promise<string[]> {
  const fatti: string[] = [];
  for (const k of await redis.keys("igpost:*")) {
    const id = k.slice(7);
    const [msg, lucchetto] = await Promise.all([redis.get<Msg>(`igmsg:${id}`), redis.get(`iglock:${id}`)]);
    if (!msg || lucchetto !== null) continue; // in coda li sistema aggiornaCoda, chiusi non si toccano
    await redis.set(`igcover:${msg.chat_id}:${msg.message_id}`, id, { ex: TTL });
    if (await redis.exists(`igcop:${id}`)) await aggiornaManuale(id);
    else {
      const auto = await redis.exists(`igauto:${id}`);
      const bottoni = auto
        ? [{ text: "❌ Annulla", callback_data: `igx:${id}` }, { text: "✅ In coda subito", callback_data: `ig:${id}` }]
        : [{ text: "✅ Pubblica", callback_data: `ig:${id}` }, { text: "❌ Scarta", callback_data: `igx:${id}` }];
      await tg("editMessageReplyMarkup", { ...msg, reply_markup: { inline_keyboard: [bottoni, bottoniModifica(id)] } }).catch(() => {});
    }
    fatti.push(id);
  }
  await aggiornaCoda();
  return fatti;
}
