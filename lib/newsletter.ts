import crypto from "crypto";
import { redis } from "./store";
import { avvisaAdmin, tg } from "./telegram";
import { programmaChiamata } from "./qstash";
import type { News } from "./news-csi";
import { inProva, v3 } from "./prova";

// Newsletter settimanale (grilling 2026-10-08, costruita 2026-10-09).
// Ogni news CSI nel topic 📰 RSS CSI ha il bottone 📧: chi lo preme la mette nella mail della settimana.
// Venerdì 10:00 (pianificazione QStash, ora italiana) anteprima nel gruppo con ❌ Annulla / ✅ Invia ora;
// senza risposta parte dopo ATTESA_MIN, cioè alle 10:30 (orari scelti dall'admin 2026-10-13).
// Nessuna news scelta = nessuna mail.
//
// MODALITÀ TEST (default): ogni invio va SOLO a NEWSLETTER_TEST_EMAIL, con una mail transazionale.
// Le liste vere (Allenatori + Dirigenti) si usano solo con NEWSLETTER_LIVE=1, decisione dell'admin.

const LIVE = () => process.env.NEWSLETTER_LIVE === "1";
const TEST_EMAIL = () => process.env.NEWSLETTER_TEST_EMAIL || "admin@example.org";
const LISTE = () => (process.env.NEWSLETTER_LISTE || "5,4").split(",").map(Number); // 5 Allenatori, 4 Dirigenti
const MITTENTE = () => ({
  name: process.env.NEWSLETTER_MITTENTE_NOME || "SS Cormano ASD-APS",
  email: process.env.NEWSLETTER_MITTENTE_EMAIL || "news@example.org",
});
const ATTESA_MIN = 30;
const TTL_NEWS = 30 * 86_400;
const SCELTE = "nl:scelte"; // set di chiavi news scelte per la prossima mail

export const chiaveNews = (url: string) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);

export const bottoneNews = (k: string, scelta: boolean) => ({
  inline_keyboard: [[{ text: scelta ? "✅ In newsletter (tocca per togliere)" : "📧 Metti in newsletter", callback_data: `nl:${k}` }]],
});

// Chiamata da pubblicaNuove per ogni news mandata nel gruppo
export const salvaNews = (n: News) => redis.set(`nl:n:${chiaveNews(n.url)}`, n, { ex: TTL_NEWS });

// Messaggio che porta il bottone della news: serve per riportarlo a 📧 dopo invio o annullamento
export const salvaBottone = (k: string, chat_id: number, message_id: number) => redis.set(`nl:btn:${k}`, { chat_id, message_id }, { ex: TTL_NEWS });

// Bottone 📧 su una news: aggiunge o toglie
export async function suBottoneNews(q: any) {
  const k = String(q.data).slice(3);
  if (!(await redis.exists(`nl:n:${k}`))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "News troppo vecchia, non più disponibile.", show_alert: true });
    return;
  }
  const scelta = !(await redis.sismember(SCELTE, k));
  if (scelta) await redis.sadd(SCELTE, k);
  else await redis.srem(SCELTE, k);
  // Dove sta il bottone: dopo l'invio torna a 📧 (2026-10-09)
  await redis.set(`nl:btn:${k}`, { chat_id: q.message.chat.id, message_id: q.message.message_id }, { ex: TTL_NEWS });
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: scelta ? "Aggiunta alla newsletter di venerdì" : "Tolta dalla newsletter" });
  await tg("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: bottoneNews(k, scelta) }).catch(() => {});
}

// News scelte, con la loro chiave. Una news scelta ma non più in Redis viene segnalata, non persa in silenzio
async function newsScelte(): Promise<{ ks: string[]; news: News[]; perse: string[] }> {
  const tutte = await redis.smembers(SCELTE);
  const lette = await Promise.all(tutte.map((k) => redis.get<News>(`nl:n:${k}`)));
  const ks = tutte.filter((_, i) => lette[i]);
  return { ks, news: lette.filter(Boolean) as News[], perse: tutte.filter((_, i) => !lette[i]) };
}

// Venerdì: anteprima nel gruppo e invio programmato
export async function anteprima(chatId: number) {
  if (v3(chatId)) return anteprimaV3(chatId);
  const { ks, news, perse } = await newsScelte();
  if (perse.length) await avvisaAdmin(`⚠️ Newsletter: ${perse.length} news scelte non trovate in Redis (${perse.join(", ")})`);
  if (!news.length) return 0;
  // Una sola anteprima valida: due anteprime (es. /newsletter e il cron del venerdì) mandavano due mail uguali (bug 2026-10-10).
  // La nuova sostituisce la precedente non ancora inviata o annullata; il lucchetto ferma anche il suo invio programmato.
  const prec = await redis.get<string>(ULTIMA);
  if (prec && (await prendi(prec, "sostituita"))) await chiudi(prec, "🔁 Sostituita dall'anteprima più recente, più sotto.");
  const id = crypto.randomBytes(9).toString("base64url");
  const dest = LIVE() ? `liste Brevo (${LISTE().join(", ")})` : `SOLO TEST a ${TEST_EMAIL()}`;
  const ora = new Date(Date.now() + ATTESA_MIN * 60_000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
  const testo = `📧 Newsletter della settimana, ${news.length} news:\n${news.map((n) => `• ${n.titolo}`).join("\n")}\n\nDestinatari: ${dest}\nParte alle ${ora} se nessuno annulla.`;
  const m = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: testo,
    reply_markup: { inline_keyboard: [[{ text: "❌ Annulla", callback_data: `nlx:${id}` }, { text: "✅ Invia ora", callback_data: `nlok:${id}` }]] },
  });
  // Le news dell'anteprima sono congelate qui: la mail contiene esattamente queste (bug 2026-10-09: anteprima 3, mail 2)
  await redis.set(`nl:msg:${id}`, { chat_id: chatId, message_id: m.message_id, testo, ks }, { ex: 2 * 86_400 });
  await redis.set(ULTIMA, id, { ex: 2 * 86_400 });
  try {
    await programmaChiamata(`${process.env.BASE_URL}/api/nl-invia?id=${id}`, ATTESA_MIN);
  } catch (e) {
    // Senza programmazione il messaggio non deve promettere l'invio automatico: resta il ✅ a mano
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: m.message_id,
      text: testo.replace(/Parte alle .*$/, "⚠️ Invio automatico non programmato: premi ✅ per inviare."),
      reply_markup: { inline_keyboard: [[{ text: "❌ Annulla", callback_data: `nlx:${id}` }, { text: "✅ Invia ora", callback_data: `nlok:${id}` }]] },
    }).catch(() => {});
    await avvisaAdmin(`⚠️ Newsletter: invio automatico non programmato (${(e as Error).message})`);
  }
  return news.length;
}

const ULTIMA = "nl:ultima"; // id dell'ultima anteprima: una nuova sostituisce la precedente (3.0: una per gruppo, "nl:ultima:<chat>")

// Lucchetto: ✅, ❌, invio automatico e sostituzione agiscono una volta sola
const prendi = (id: string, stato: string) => redis.set(`nl:lock:${id}`, stato, { nx: true, ex: 2 * 86_400 });

type MsgNl = { chat_id: number; message_id: number; testo: string; ks?: string[] };

async function chiudi(id: string, riga: string) {
  const m = await redis.get<MsgNl>(`nl:msg:${id}`);
  if (!m) return;
  // Se la modifica del messaggio non riesce (2026-10-09: mail partita, nessuna conferma), lo dice con un messaggio nuovo
  await tg("editMessageText", { chat_id: m.chat_id, message_id: m.message_id, text: `${m.testo}\n\n${riga}` }).catch((e) => {
    console.error("newsletter chiudi", e);
    return tg("sendMessage", { chat_id: m.chat_id, text: riga, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  });
}

export async function suBottoneInvio(q: any) {
  const [tipo, id] = String(q.data).split(":");
  if (!(await prendi(id, tipo))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Già gestita." });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  const chi = q.from.first_name || "qualcuno";
  if (tipo === "nlx") {
    const m = await redis.get<MsgV3>(`nl:msg:${id}`);
    // 3.0: annullata = quelle notizie escono dalla settimana
    if (m?.v3 && m.ks?.length) await redis.srem(kSettimana(m.chat_id), ...(m.ks as [string, ...string[]]));
    await azzeraScelte(m?.ks ?? []);
    return chiudi(id, `❌ Annullata da ${chi}.`);
  }
  await inviaEChiudi(id, `da ${chi}`);
}

// Chiamata da QStash allo scadere dell'attesa
export async function invioProgrammato(id: string) {
  if (!(await prendi(id, "auto"))) return;
  await inviaEChiudi(id, "in automatico");
}

async function inviaEChiudi(id: string, come: string) {
  try {
    const m = await redis.get<MsgNl>(`nl:msg:${id}`);
    if ((m as MsgV3 | null)?.v3) return await inviaV3(id, m as MsgV3, come);
    // Solo le news ancora scelte: chi ha tolto il 📧 dopo l'anteprima non la ritrova nella mail
    const ks = m?.ks ?? [];
    const ancora = await Promise.all(ks.map((k) => redis.sismember(SCELTE, k)));
    const n = await invia(ks.filter((_, i) => ancora[i]));
    await chiudi(id, n ? `✅ Inviata ${come} con ${n} news${LIVE() ? "" : ` (TEST, solo a ${TEST_EMAIL()})`}.` : "Nessuna news trovata, niente mail.");
  } catch (e) {
    await chiudi(id, "⚠️ Invio fallito, avvisato l'admin.");
    await avvisaAdmin(`❌ Newsletter non inviata: ${(e as Error).message}`);
  }
}

async function brevo(path: string, body: unknown) {
  const r = await fetch(`https://api.brevo.com/v3/${path}`, {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY || "", "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Brevo ${path} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

export async function invia(ks: string[]): Promise<number> {
  const news = (await Promise.all(ks.map((k) => redis.get<News>(`nl:n:${k}`)))).filter(Boolean) as News[];
  if (news.length < ks.length) await avvisaAdmin(`⚠️ Newsletter: ${ks.length - news.length} news dell'anteprima non trovate, inviate ${news.length}`);
  if (!news.length) return 0;
  console.log(`newsletter: invio ${news.length} news: ${news.map((n) => n.titolo).join(" | ")}`);
  const oggetto = `Le novità della settimana da SS Cormano ASD-APS`;
  if (LIVE()) {
    const c = await brevo("emailCampaigns", { name: `Newsletter ${new Date().toISOString().slice(0, 10)}`, subject: oggetto, sender: MITTENTE(), htmlContent: html(news, true), recipients: { listIds: LISTE() } });
    await brevo(`emailCampaigns/${c.id}/sendNow`, {});
  } else {
    await brevo("smtp/email", { sender: MITTENTE(), to: [{ email: TEST_EMAIL() }], subject: `[TEST] ${oggetto}`, htmlContent: html(news, false) });
  }
  await azzeraScelte(ks);
  return news.length;
}

// Dopo invio o annullamento: le news di quell'anteprima non sono più scelte, i loro bottoni tornano a 📧 (2026-10-09).
// Le news scelte dopo l'anteprima restano per la prossima
async function azzeraScelte(ks: string[]) {
  if (ks.length) await redis.srem(SCELTE, ...(ks as [string, ...string[]]));
  for (const k of ks) {
    const b = await redis.get<{ chat_id: number; message_id: number }>(`nl:btn:${k}`);
    if (b) await tg("editMessageReplyMarkup", { ...b, reply_markup: bottoneNews(k, false) }).catch(() => {});
  }
}

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function html(news: News[], campagna: boolean): string {
  const blocchi = news
    .map(
      (n) => `<tr><td style="padding:0 0 28px">
${n.img ? `<img src="${esc(n.img)}" width="560" style="width:100%;max-width:560px;border-radius:6px;display:block" alt="">` : ""}
<h2 style="font:bold 20px Arial,sans-serif;color:#008000;margin:14px 0 6px">${esc(n.titolo)}</h2>
${n.testo || n.sottotitolo ? `<p style="font:15px/1.5 Arial,sans-serif;color:#333;margin:0 0 10px">${esc(n.testo || n.sottotitolo)}</p>` : ""}
<a href="${esc(n.url)}" style="font:bold 14px Arial,sans-serif;color:#008000">Leggi tutto →</a>
</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html><body style="margin:0;background:#f2f4f2">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px">
<tr><td style="background:#008000;padding:20px;text-align:center;border-radius:8px 8px 0 0">
<img src="${process.env.BASE_URL}/api/setup?logo=3" width="120" height="120" alt="SS Cormano ASD-APS" style="display:block;margin:0 auto 8px"><span style="font:bold 22px Arial,sans-serif;color:#ffffff">SS Cormano ASD-APS</span><br>
<span style="font:15px Arial,sans-serif;color:#fff">Le novità della settimana dal CSI</span></td></tr>
<tr><td style="padding:24px 20px"><table width="100%" cellpadding="0" cellspacing="0">${blocchi}</table></td></tr>
<tr><td style="padding:16px 20px;background:#f7f7f7;font:12px Arial,sans-serif;color:#777;text-align:center;border-radius:0 0 8px 8px">
SS Cormano ASD-APS, example.org${campagna ? `<br><a href="{{ unsubscribe }}" style="color:#777">Disiscriviti</a>` : "<br>(mail di test: nelle mail vere qui c'è il link per disiscriversi)"}
</td></tr></table></td></tr></table></body></html>`;
}

// ---- 3.0 (2026-10-25): newsletter con tutte le notizie della settimana già dentro ----
// Le notizie arrivano in silenzio (solo quelle con le parole chiave escono subito nel gruppo, con 📧 Manda subito).
// Il venerdì l'anteprima le elenca tutte, ognuna con ✖️ per toglierla; la mail parte 90 minuti dopo (10:30 → 12:00).
// Nel gruppo di prova la mail non parte mai: "🧪 PROVA".
const ATTESA_V3_MIN = 90;
export const kSettimana = (chat: number) => `nl:settimana:${chat}`; // chiavi delle notizie della settimana

// Notizie da far vedere subito (2026-10-25): eventi grandi, residenziali, scadenze. Elenco fisso
const IMPORTANTI = /\b(powervolley|inter|residenzial\w*|camp|iscrizion\w*|scadenz\w*|torne\w*|selezion\w*)\b/i;
export const importante = (n: News) => IMPORTANTI.test(`${n.titolo} ${n.sottotitolo ?? ""} ${n.testo ?? ""}`);
export const bottoneSubito = (k: string) => ({ inline_keyboard: [[{ text: "📧 Manda subito", callback_data: `nlu:${k}` }]] });

type MsgV3 = MsgNl & { esclusi?: string[]; v3?: boolean };
const tastieraV3 = (id: string, ks: string[], titoli: string[], esclusi: string[]) => [
  ...ks.map((k, i) => [{ text: `${esclusi.includes(k) ? "➕ Rimetti" : "✖️ Togli"}: ${titoli[i].slice(0, 40)}`, callback_data: `nlt:${id}:${k}` }]),
  [{ text: "❌ Annulla", callback_data: `nlx:${id}` }, { text: "✅ Invia ora", callback_data: `nlok:${id}` }],
];
const testoV3 = (news: News[], ks: string[], esclusi: string[], ora: string, prova: boolean) => {
  const dentro = ks.filter((k) => !esclusi.includes(k)).length;
  return `📧 Newsletter della settimana: ${dentro} notizie su ${ks.length}\n${news.map((n, i) => `${esclusi.includes(ks[i]) ? "✖️" : "•"} ${n.titolo}`).join("\n")}\n\nCon ✖️ togli una notizia. ${prova ? "🧪 PROVA: la mail non parte, " : ""}Parte alle ${ora} se nessuno annulla.`;
};

async function anteprimaV3(chatId: number, solo?: string[]): Promise<number> {
  const tutte = solo ?? ((await redis.smembers(kSettimana(chatId))) as string[]);
  const lette = await Promise.all(tutte.map((k) => redis.get<News>(`nl:n:${k}`)));
  const ks = tutte.filter((_, i) => lette[i]);
  const news = lette.filter(Boolean) as News[];
  if (!news.length) return 0;
  const prec = await redis.get<string>(`${ULTIMA}:${chatId}`);
  if (prec && (await prendi(prec, "sostituita"))) await chiudi(prec, "🔁 Sostituita dall'anteprima più recente, più sotto.");
  const id = crypto.randomBytes(9).toString("base64url");
  const ora = new Date(Date.now() + ATTESA_V3_MIN * 60_000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
  const testo = testoV3(news, ks, [], ora, inProva(chatId));
  const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: testo, reply_markup: { inline_keyboard: tastieraV3(id, ks, news.map((n) => n.titolo), []) } });
  await redis.set<MsgV3>(`nl:msg:${id}`, { chat_id: chatId, message_id: m.message_id, testo, ks, esclusi: [], v3: true }, { ex: 2 * 86_400 });
  await redis.set(`nl:ora:${id}`, ora, { ex: 2 * 86_400 });
  await redis.set(`${ULTIMA}:${chatId}`, id, { ex: 2 * 86_400 });
  await programmaChiamata(`${process.env.BASE_URL}/api/nl-invia?id=${id}`, ATTESA_V3_MIN).catch((e) => avvisaAdmin(`⚠️ Newsletter: invio automatico non programmato (${(e as Error).message})`));
  return news.length;
}

// ✖️ Togli / ➕ Rimetti una notizia dall'anteprima (nlt:<id>:<chiave>)
export async function suToggleNews(q: any) {
  const [, id, k] = String(q.data).split(":");
  const m = await redis.get<MsgV3>(`nl:msg:${id}`);
  if (!m || (await redis.exists(`nl:lock:${id}`))) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Anteprima già chiusa." });
    return;
  }
  const esclusi = m.esclusi ?? [];
  const nuovi = esclusi.includes(k) ? esclusi.filter((x) => x !== k) : [...esclusi, k];
  const news = (await Promise.all((m.ks ?? []).map((x) => redis.get<News>(`nl:n:${x}`)))).map((n) => n as News);
  const ora = (await redis.get<string>(`nl:ora:${id}`)) || "";
  const testo = testoV3(news, m.ks ?? [], nuovi, ora, inProva(m.chat_id));
  await redis.set<MsgV3>(`nl:msg:${id}`, { ...m, esclusi: nuovi, testo }, { keepTtl: true });
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: nuovi.includes(k) ? "Tolta" : "Rimessa" });
  await tg("editMessageText", { chat_id: m.chat_id, message_id: m.message_id, text: testo, reply_markup: { inline_keyboard: tastieraV3(id, m.ks ?? [], news.map((n) => n.titolo), nuovi) } }).catch(() => {});
}

// 📧 Manda subito su una notizia importante: anteprima con quella sola notizia
export async function suMandaSubito(q: any) {
  const k = String(q.data).slice(4);
  const n = await anteprimaV3(q.message.chat.id, [k]);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: n ? "Anteprima pronta" : "Notizia non più disponibile", show_alert: !n });
}

// Invio di un'anteprima 3.0: solo le notizie non tolte; dal gruppo di prova mai una mail
async function inviaV3(id: string, m: MsgV3, come: string) {
  const ks = (m.ks ?? []).filter((k) => !(m.esclusi ?? []).includes(k));
  if (ks.length) await redis.srem(kSettimana(m.chat_id), ...(ks as [string, ...string[]]));
  if (inProva(m.chat_id)) return chiudi(id, `🧪 PROVA: qui sarebbe partita la mail ${come} con ${ks.length} notizie.`);
  const n = await invia(ks);
  return chiudi(id, n ? `✅ Inviata ${come} con ${n} notizie${LIVE() ? "" : ` (TEST, solo a ${TEST_EMAIL()})`}.` : "Nessuna notizia, niente mail.");
}
