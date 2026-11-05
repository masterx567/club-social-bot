import { Redis } from "@upstash/redis";

// L'integrazione Upstash di Vercel crea KV_REST_API_* oppure UPSTASH_REDIS_REST_*
export const redis = new Redis({
  url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)!,
  token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)!,
});

// evTitolo / evSottotitolo: domande di /evento (titolo giallo, poi sottotitolo bianco; l'admin 2026-10-11)
// partita / punti: /risultato sceglie la partita dall'elenco dei portali, poi si scrive solo il punteggio (2026-10-20)
export type Ente = "CSI" | "UISP" | "FIP";
export type Step = "squadra" | "ente" | "avversario" | "puntiLV" | "menu" | "sport" | "categoria" | "risultato" | "evScelta" | "evTitolo" | "evSottotitolo" | "partita" | "punti";

export interface Stato {
  step: Step;
  fileId: string; // foto Telegram
  photoMsgId: number; // messaggio con la foto, per rispondere in thread
  promptMsgId?: number; // messaggio del bot con i bottoni
  sport?: string;
  categoria?: string;
  tipo?: "risultato" | "amichevole" | "torneo"; // quale template usare
  // Punteggio già letto dalla didascalia: dopo i bottoni non va richiesto
  punteggio?: { risultato: string; squadraA: string; squadraB: string };
  // /evento: titolo giallo già scelto ("" = nessuno) e sottotitolo già scritto nella didascalia
  titolo?: string;
  sottotitolo?: string;
  // /risultato: id delle partite nei bottoni, poi la partita scelta (nomi in grafica e URL dei loghi sul portale)
  scelte?: string[];
  partita?: { casa: string; ospite: string; logoCasa?: string; logoOspite?: string; ente?: Ente };
  avversario?: string; // 3.0: amichevole o partita fuori elenco, nome scritto dal volontario
  ente?: Ente; // 3.0: logo del campionato in grafica (partita fuori elenco: scelto con i bottoni)
}

const TTL = 30 * 60; // richieste a metà scadono dopo 30 minuti
const key = (chatId: number, userId: number) => `st:${chatId}:${userId}`;

export const getStato = (c: number, u: number) => redis.get<Stato>(key(c, u));
export const setStato = (c: number, u: number, s: Stato) => redis.set(key(c, u), s, { ex: TTL });
export const delStato = (c: number, u: number) => redis.del(key(c, u));
