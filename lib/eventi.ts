import { redis } from "./store";

// Contatori per la pipeline degli aggiornamenti (l'admin 2026-10-29, .claude/context/pipeline-aggiornamenti.md):
// dove i volontari si bloccano e cosa usano, per le idee di Claude ogni 2 settimane (scripts/dossier.ts).
// Hash "eventi:AAAA-MM-GG" (giorno di Roma) evento -> quante volte, tenuto 120 giorni. Mai bloccante.
// Il gruppo di prova non conta: le prove falserebbero i numeri.
const GIORNI = 120;
const PROVA = -1001234567890;

export type Evento =
  | "menu_aperto" | "menu_risultato" | "menu_foto" | "menu_niente" | "menu_scaduto"
  | "annulla" | "logo_caricato" | "logo_saltato"
  | "bozza_altra" | "pubblica_bozza" | "pubblica_mio" | "cronaca_coach"
  | "domande_saltate" | "domande_scadute";

const giorno = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

export async function conta(evento: Evento, chat?: unknown) {
  if (Number(chat) === PROVA) return;
  try {
    const k = `eventi:${giorno()}`;
    await redis.hincrby(k, evento, 1);
    await redis.expire(k, GIORNI * 86_400);
  } catch {
    /* un contatore non ferma mai il bot */
  }
}

// Errori in parole semplici (⚠️ ERRORI) e tecnici (privato dell'admin): ultimi 300, per il dossier
export async function registraErrore(testo: string, dove: "gruppo" | "admin") {
  try {
    await redis.lpush("log:errori", JSON.stringify({ ms: Date.now(), dove, testo: testo.slice(0, 500) }));
    await redis.ltrim("log:errori", 0, 299);
  } catch {
    /* mai bloccante */
  }
}
