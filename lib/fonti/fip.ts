import type { Partita } from "../partite";

// Ricerca pubblica fip.it: date in formato ISO, altrimenti risponde "nessuna gara" senza errore.
// La pagina è HTML servito già pronto (WordPress), un blocco .results-matches__match per gara.
const URL_RICERCA = "https://fip.it/risultati/";

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

const testo = (s = "") =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// "04 Ottobre 2026" -> "2026-10-04"
const isoData = (s: string) => {
  const m = s.toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  const mese = m ? MESI.indexOf(m[2]) + 1 : 0;
  return m && mese ? `${m[3]}-${String(mese).padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};

const isoGiorno = (d: Date) => d.toISOString().slice(0, 10);

// Estrae le gare da una pagina di ricerca. Esportata per i test su HTML salvato.
export function leggiGareFip(html: string): Partita[] {
  // Ogni blocco finisce prima della legenda di fine pagina ("Omologazione sospesa" ecc.), che non riguarda la gara
  const blocchi = html.split('<div class="results-matches__match">').slice(1).map((b) => b.split("results-matches__legenda")[0]);
  const out: Partita[] = [];
  for (const b of blocchi) {
    const nomi = [...b.matchAll(/class="team__name">([\s\S]*?)<\/div>/g)].map((m) => testo(m[1]));
    const punti = [...b.matchAll(/class="team__points">([\s\S]*?)<\/div>/g)].map((m) => testo(m[1]));
    const data = isoData(testo(b.match(/class="date">([\s\S]*?)<\/div>/)?.[1]));
    const ora = testo(b.match(/class="time">([\s\S]*?)<\/div>/)?.[1]);
    // Una voce per riga: "001460", "-", "COMITATO REGIONALE LOMBARDIA", "Divisione regionale 2", "M, Girone:", ...
    const ref = (b.match(/class="ref"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "").split("\n").map((r) => testo(r)).filter(Boolean);
    const numero = ref[0]?.match(/^\d+$/)?.[0];
    const campionato = ref[3] || "";
    if (nomi.length < 2 || !numero || !/ss cormano/i.test(nomi.join(" "))) continue;

    const [pc, po] = punti.map((p) => (/^\d+$/.test(p) ? Number(p) : undefined));
    out.push({
      id: `fip:${campionato}:${numero}`,
      ente: "FIP",
      campionato,
      campionatoNome: campionato,
      data,
      ora,
      casa: nomi[0],
      ospite: nomi[1],
      pc,
      po,
      // FIP non segna i rinvii nella ricerca: la gara spostata cambia data, e il calendario aggiornato la rimette al posto giusto
      stato: pc !== undefined && po !== undefined ? "giocata" : "da_giocare",
    });
  }
  return out;
}

// Gare SS CORMANO da 45 giorni fa a 90 giorni avanti: copre recuperi e calendario. Con 15 giorni una gara rinviata
// più in là non tornava più e restava salvata alla data vecchia, senza risultato (Ripress Nova U15, 30/10 → 20/11)
export async function partiteFip(): Promise<Partita[]> {
  const giorno = 86_400_000;
  const qs = new URLSearchParams({
    search: "true",
    nome_squadra: "SS CORMANO",
    data_da: isoGiorno(new Date(Date.now() - 45 * giorno)),
    data_a: isoGiorno(new Date(Date.now() + 90 * giorno)),
  });
  const r = await fetch(`${URL_RICERCA}?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`FIP ${r.status}`);
  return leggiGareFip(await r.text());
}
