// Formato: "1 SSC - 3 PUOK" (punteggio + squadra, per ciascuna delle due squadre)
export interface Punteggio {
  risultato: string; // "1 - 3"
  squadraA: string; // "SS CORMANO"
  squadraB: string; // "PUOK"
}

// Sigle espanse nella grafica
const SIGLE: Record<string, string> = { SSC: "SS CORMANO" };

// Trattini: la tastiera del telefono può trasformare "-" in "–", "—", "−" (U+2212), "‒"
// "1 SSC - 3 PUOK"
const RE = /(\d{1,3})\s+([^\d\n\-–—−‒:]+?)\s*[-–—−‒:]\s*(\d{1,3})\s+([^\d\n\-–—−‒:/]+)/;
// "SSC 42 - 74 OSAL NOVATE" (squadra prima del primo numero)
const RE_NOME_PRIMA = /([^\d\n\-–—−‒:]+?)\s+(\d{1,3})\s*[-–—−‒:]\s*(\d{1,3})\s+([^\d\n\-–—−‒:/]+)/;
// "SS Cormano 3 - Precotto 3" (ogni squadra seguita dal suo punteggio; caso reale 2026-10-11)
const RE_NOME_PUNTI = /([^\d\n\-–—−‒:]+?)\s+(\d{1,3})\s*[-–—−‒:]\s*([^\d\n\-–—−‒:/]+?)\s+(\d{1,3})(?!\d)/;

// Parole di sport/categoria che possono finire sulla stessa riga prima della squadra A
const RUMORE = /\b(calcio|volley|pallavolo|basket|giocasport|open|eccellenza|under|femm\.?)\b/gi;

const squadra = (s: string) => {
  const n = s.replace(RUMORE, " ").replace(/\s+/g, " ").trim().replace(/[.,;!]+$/, "").toUpperCase();
  return SIGLE[n] ?? n;
};

export function leggiPunteggio(testo: string): Punteggio | null {
  const m = testo.match(RE);
  if (m) return { risultato: `${m[1]} - ${m[3]}`, squadraA: squadra(m[2]), squadraB: squadra(m[4]) };
  const n = testo.match(RE_NOME_PRIMA);
  if (n && squadra(n[1])) return { risultato: `${n[2]} - ${n[3]}`, squadraA: squadra(n[1]), squadraB: squadra(n[4]) };
  const p = testo.match(RE_NOME_PUNTI);
  if (p && squadra(p[1]) && squadra(p[3])) return { risultato: `${p[2]} - ${p[4]}`, squadraA: squadra(p[1]), squadraB: squadra(p[3]) };
  return null;
}

export const ESEMPIO = "1 SSC - 3 PUOK";
