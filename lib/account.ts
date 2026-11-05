import crypto from "crypto";
import { redis } from "./store";
import { tg } from "./telegram";

// Tag delle squadre avversarie su Instagram (Issue 10, l'admin 2026-11-02). Partite della settimana: ogni avversaria
// viene taggata sul suo logo. Account in Redis (hash "igaccount": nome squadra -> username, "-" = nessun account).
// Gli account mancanti li chiede il bot all'admin in privato, una volta per squadra: la grafica non cambia, i tag
// si mettono al momento della pubblicazione, quindi basta rispondere prima che il post esca.

const K = "igaccount";
const NESSUNO = "-";
const TTL_DOMANDA = 30 * 86_400;
const corto = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

// Centro del logo avversario nei 5 template delle partite (uguale in tutti, slide 1122x1402), riga 1..5
const LOGO_X = 582.5 / 1122;
const LOGO_Y = [553, 715, 861, 988, 1151].map((y) => y / 1402);

export type Tag = { username: string; x: number; y: number; nome?: string };
const MAX_ERRORI = 2; // tag rifiutato 2 volte: account tolto e richiesto all'admin

export async function accountDi(nome: string): Promise<string | null> {
  const a = await redis.hget<string>(K, nome.toUpperCase());
  return a && a !== NESSUNO ? a : null;
}

// Una riga per avversaria, nell'ordine della slide: tag sul suo logo. Senza account niente tag.
export async function tagSlide(avversari: string[]): Promise<Tag[]> {
  const tag: Tag[] = [];
  for (const [i, nome] of avversari.entries()) {
    const username = await accountDi(nome);
    if (username && LOGO_Y[i] !== undefined) tag.push({ username, x: LOGO_X, y: LOGO_Y[i], nome: nome.toUpperCase() });
  }
  return tag;
}

// Account esistente e visibile (Business Discovery vede solo account business o creator pubblici)
async function esiste(username: string): Promise<boolean> {
  const t = await redis.get<{ token: string; igUserId: string; tipo: string }>("ig:token");
  if (!t) return true; // senza login non si può controllare: si prende per buono
  const base = t.tipo === "facebook" ? "https://graph.facebook.com/v23.0" : "https://graph.instagram.com/v23.0";
  const r = await fetch(`${base}/${t.igUserId}?fields=business_discovery.username(${encodeURIComponent(username)}){username}&access_token=${t.token}`);
  return r.ok;
}

// Tag rifiutato da Meta (l'admin 2026-11-02: una squadra con l'account sbagliato non deve dare errore ogni volta).
// Si controlla account per account: quelli che non si trovano più prendono un errore; al secondo l'account si
// toglie e si richiede all'admin. Ritorna i tag ancora buoni, da riprovare.
export async function gestisciTagRifiutati(tag: Tag[]): Promise<{ buoni: Tag[]; tolti: string[] }> {
  const buoni: Tag[] = [];
  const tolti: string[] = [];
  for (const t of tag) {
    if (await esiste(t.username)) {
      buoni.push(t);
      continue;
    }
    const nome = t.nome ?? t.username;
    const n = await redis.hincrby("igaccount:errori", nome, 1);
    if (n >= MAX_ERRORI) {
      await redis.hdel(K, nome);
      await redis.hdel("igaccount:errori", nome);
      await redis.del(`igaccount:chiesto:${nome}`);
      tolti.push(`${nome} (@${t.username})`);
      await chiediAccount([nome]);
    }
  }
  return { buoni, tolti };
}

export const perMeta = (tag: Tag[]) => JSON.stringify(tag.map(({ username, x, y }) => ({ username, x, y })));

// Chiede all'admin gli account che mancano, una domanda per squadra, mai due volte
export async function chiediAccount(nomi: string[]) {
  const admin = process.env.ADMIN_CHAT_ID;
  if (!admin) return;
  for (const n of [...new Set(nomi.map((x) => x.toUpperCase()))]) {
    if (/SS CORMANO/.test(n) || (await redis.hexists(K, n))) continue;
    if (!(await redis.set(`igaccount:chiesto:${n}`, 1, { nx: true, ex: TTL_DOMANDA }))) continue;
    const id = corto(n);
    const m = await tg<{ message_id: number }>("sendMessage", {
      chat_id: admin,
      text: `📸 Account Instagram di ${n}?\nRispondi a questo messaggio con il nome, es. @asdgiravolta. Lo taggo sul suo logo nelle partite della settimana.`,
      reply_markup: { inline_keyboard: [[{ text: "⏭ Non ha Instagram", callback_data: `iga:${id}` }]] },
    }).catch(() => null);
    if (!m) continue;
    await redis.set(`igaccount:msg:${m.message_id}`, n, { ex: TTL_DOMANDA });
    await redis.set(`igaccount:id:${id}`, n, { ex: TTL_DOMANDA });
  }
}

// Risposta con @nome alla domanda. true = gestita
export async function suRispostaAccount(m: any): Promise<boolean> {
  const rif = m.reply_to_message?.message_id;
  if (!rif || String(m.chat.id) !== String(process.env.ADMIN_CHAT_ID)) return false;
  const nome = await redis.get<string>(`igaccount:msg:${rif}`);
  if (!nome) return false;
  const reply = (text: string) => tg("sendMessage", { chat_id: m.chat.id, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  const u = String(m.text || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[/?].*$/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) {
    await reply("Scrivimi solo il nome dell'account, es. @asdgiravolta.");
    return true;
  }
  if (!(await esiste(u))) {
    await reply(`Non trovo @${u} su Instagram (o è privato). Controlla e riscrivilo.`);
    return true;
  }
  await redis.hset(K, { [nome]: u });
  await redis.del(`igaccount:msg:${rif}`);
  await reply(`✅ ${nome} → @${u}`);
  return true;
}

// ⏭ Non ha Instagram
export async function suBottoneAccount(q: any) {
  const id = String(q.data).slice(4);
  const nome = await redis.get<string>(`igaccount:id:${id}`);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: nome ? "Ok" : "Domanda scaduta." });
  if (!nome) return;
  await redis.hset(K, { [nome]: NESSUNO });
  await tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text: `⏭ ${nome}: niente tag.` }).catch(() => {});
}
