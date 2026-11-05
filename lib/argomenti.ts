import { AsyncLocalStorage } from "node:async_hooks";
import { redis } from "./store";
import { inProva } from "./prova";

// Il gruppo è un forum con argomenti (decisione 2026-10-08). Ogni messaggio del bot verso il gruppo
// va nell'argomento "corrente": quello in cui è stato scritto il comando, o quello fisso del cron.
// L'argomento corrente viaggia con la richiesta (AsyncLocalStorage), così tg()/inviaFoto/inviaAlbum
// lo aggiungono da soli senza passarlo in ogni funzione.

export type Argomento = "automatici" | "manuali" | "novita" | "csi" | "statistiche" | "errori";

export const NOMI: Record<Argomento, string> = {
  automatici: "🤖 Post automatici", // nomi cambiati dall'admin 2026-10-10 (prima "Automatici" e "Manuali")
  manuali: "✍️ Post manuali",
  novita: "📣 Novità ed eventi", // post /evento
  csi: "📰 RSS CSI", // news dal sito CSI (cron-news), dal 2026-10-09
  statistiche: "📊 Statistiche",
  errori: "⚠️ ERRORI", // 3.0: errori in italiano semplice, argomento chiuso (scrivono bot e amministratori)
};

const corrente = new AsyncLocalStorage<number | undefined>();

export const threadCorrente = () => corrente.getStore();

// Esegue fn con l'argomento dato (id del thread Telegram; undefined = Generale)
export const nelThread = <T>(thread: number | undefined, fn: () => Promise<T>) => corrente.run(thread, fn);

// Id del thread di un argomento, salvato quando il bot l'ha creato (Redis hash "argomenti")
// Il gruppo di prova ha i suoi argomenti (hash "argomenti:<chat>"), creati a mano una volta
export const idArgomento = async (a: Argomento, chat?: number) =>
  (await redis.hget<number>(chat !== undefined && inProva(chat) ? `argomenti:${chat}` : "argomenti", a)) ?? undefined;

export const nellArgomento = async <T>(a: Argomento, fn: () => Promise<T>) => nelThread(await idArgomento(a), fn);

// Solo verso gruppi (id negativi): le chat private non hanno argomenti
export const threadPer = (chatId: unknown) => (Number(chatId) < 0 ? threadCorrente() : undefined);
