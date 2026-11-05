import { idArgomento, threadPer } from "./argomenti";
import { inProva } from "./prova";
import { registraErrore } from "./eventi";
import { redis } from "./store";

// Messaggi nel Generale del gruppo, per /reset (2026-10-25): Telegram non dà la cronologia ai bot,
// si annotano gli id man mano (entrati e mandati). Sorted set id -> ms.
export const K_GENERALE = "generale:msg";
export async function ricordaGenerale(chatId: unknown, thread: unknown, res: any) {
  if (Number(chatId) >= 0) return;
  const ids = (Array.isArray(res) ? res : [res]).map((x) => x?.message_id).filter(Boolean);
  if (thread) {
    // ✍️ Post manuali (2026-10-28): la pulizia cancella i messaggi uno per uno e l'argomento resta,
    // così resta fissato in cima (i bot non possono fissare gli argomenti). Vale anche nel gruppo di prova.
    if (Number(thread) === (await idArgomento("manuali", Number(chatId)).catch(() => undefined)))
      for (const id of ids) await redis.zadd(kManuali(Number(chatId)), { score: Date.now(), member: String(id) }).catch(() => {});
    return;
  }
  // Generale: solo il gruppo vero (gli id dei messaggi valgono per una chat sola, /reset li cancella lì)
  if (inProva(chatId)) return;
  for (const id of ids) await redis.zadd(K_GENERALE, { score: Date.now(), member: String(id) }).catch(() => {});
}
export const kManuali = (chatId: number) => `manuali:msg:${chatId}`;

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Per gli invii con FormData (foto, album), che non passano da tg()
const conThread = (form: FormData, chatId: number) => {
  const t = threadPer(chatId);
  if (t) form.append("message_thread_id", String(t));
};

export async function tg<T = any>(method: string, body: Record<string, unknown>, tentativi = 2): Promise<T> {
  // Messaggi nuovi verso il gruppo: nell'argomento corrente (lib/argomenti.ts)
  const thread = method.startsWith("send") && body.message_thread_id === undefined ? threadPer(body.chat_id) : undefined;
  if (thread) body = { ...body, message_thread_id: thread };
  const r = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  // Troppi messaggi di fila nello stesso gruppo (Telegram: "retry after N"): si aspetta e si riprova, invece di
  // perdere il messaggio (2026-10-26, domanda del logo mai arrivata durante le prove)
  const attesa = Number(j.parameters?.retry_after);
  if (!j.ok && j.error_code === 429 && attesa && attesa <= 20 && tentativi > 0) {
    await new Promise((ok) => setTimeout(ok, attesa * 1000 + 500));
    return tg<T>(method, body, tentativi - 1);
  }
  // La risposta a un tocco può fallire (tocco vecchio, "query is too old"): non deve fermare quello che il tocco fa
  if (!j.ok && method === "answerCallbackQuery") {
    console.error(`Telegram ${method}: ${j.description}`);
    return undefined as T;
  }
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  if (method.startsWith("send") || method === "copyMessage") await ricordaGenerale(body.chat_id, body.message_thread_id, j.result);
  return j.result;
}

export async function scaricaFile(fileId: string): Promise<Buffer> {
  const f = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) throw new Error(`Download foto Telegram: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function inviaFoto(chatId: number, img: Buffer, caption: string, replyTo?: number, tastiera?: Bottone[][]): Promise<number> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  conThread(form, chatId);
  form.append("caption", caption);
  if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
  if (tastiera) form.append("reply_markup", JSON.stringify({ inline_keyboard: tastiera }));
  form.append("photo", new Blob([new Uint8Array(img)], { type: "image/jpeg" }), "risultato.jpg");
  const r = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram sendPhoto: ${j.description}`);
  await ricordaGenerale(chatId, threadPer(chatId), j.result);
  return j.result.message_id;
}

// Album (carosello): Telegram accetta 2-10 foto per gruppo, con una sola si manda una foto normale
export async function inviaAlbum(chatId: number, imgs: Buffer[], caption: string) {
  if (imgs.length === 1) {
    await inviaFoto(chatId, imgs[0], caption);
    return;
  }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  conThread(form, chatId);
  form.append(
    "media",
    JSON.stringify(imgs.map((_, i) => ({ type: "photo", media: `attach://f${i}`, ...(i === 0 ? { caption } : {}) }))),
  );
  imgs.forEach((img, i) => form.append(`f${i}`, new Blob([new Uint8Array(img)], { type: "image/jpeg" }), `slide${i + 1}.jpg`));
  const r = await fetch(`${API()}/sendMediaGroup`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram sendMediaGroup: ${j.description}`);
  await ricordaGenerale(form.get("chat_id"), form.get("message_thread_id"), j.result);
}

export type Bottone = { text: string; callback_data: string };

export function griglia(bottoni: Bottone[], perRiga = 2): Bottone[][] {
  const righe: Bottone[][] = [];
  for (let i = 0; i < bottoni.length; i += perRiga) righe.push(bottoni.slice(i, i + perRiga));
  return righe;
}

// Errori tecnici: all'admin in privato, mai nel gruppo
export async function avvisaAdmin(testo: string) {
  const admin = process.env.ADMIN_CHAT_ID;
  if (!admin) return;
  await registraErrore(testo, "admin");
  await tg("sendMessage", { chat_id: admin, text: testo.slice(0, 4000) }).catch(() => {});
}
