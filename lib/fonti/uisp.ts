import type { Partita } from "../partite";

// Gestionale UISP Pallacanestro, pubblico. Struttura degli URL:
//   /Milano                      elenco campionati (/Milano/{id})
//   /Milano/{id}/partecipanti    squadre iscritte, titolo "U17 - Partecipanti"
//   /Milano/{id}                 fasi del campionato (/Milano/{id}/{fase})
//   /Milano/{id}/{fase}          link alle giornate (?round=R&roundnumber=N)
//   pagina giornata              una card per gara, href /Milano/{id}/{fase}/x/y/{gara}
const BASE = "https://gestionalepallacanestro.uisp.it";
const COMITATO = "Milano";

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

// Il server UISP ogni tanto chiude la connessione: tre tentativi prima di arrendersi
async function pagina(path: string): Promise<string> {
  for (let tentativo = 1; ; tentativo++) {
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) throw new Error(`UISP ${r.status} su ${path}`);
      return await r.text();
    } catch (e) {
      if (tentativo === 3) throw new Error(`UISP ${path}: ${e instanceof Error ? e.message : e}`);
      await new Promise((ok) => setTimeout(ok, 1000 * tentativo));
    }
  }
}

// Al massimo 4 richieste insieme, per non farsi chiudere la porta
async function aGruppi<T, R>(xs: T[], fn: (x: T) => Promise<R>, n = 4): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...(await Promise.all(xs.slice(i, i + n).map(fn))));
  return out;
}

const testo = (s = "") =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// "01 ottobre 2026 (gio)" -> "2026-10-01"
const isoData = (s: string) => {
  const m = s.toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  const mese = m ? MESI.indexOf(m[2]) + 1 : 0;
  return m && mese ? `${m[3]}-${String(mese).padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};

const unici = (xs: string[]) => [...new Set(xs)];

// Gare di una pagina giornata. Esportata per i test su HTML salvato.
export function leggiGareUisp(html: string, campionato: string): Partita[] {
  const out: Partita[] = [];
  // Solo il contenuto della card: dopo l'ultima card c'è il resto della pagina (classifica, script)
  for (const b of html.split('<a class="card card-flush').slice(1).map((x) => x.split("</a>")[0])) {
    const gara = b.match(/href="[^"]*\/(\d+)"/)?.[1];
    const nomi = [...b.matchAll(/fw-bolder fs-7 text-uppercase">([\s\S]*?)<\/span>/g)].map((m) => testo(m[1]));
    const punti = [...b.matchAll(/fw-bolder fs-2">([\s\S]*?)<\/span>/g)].map((m) => testo(m[1]));
    const data = isoData(testo(b.match(/text-capitalize">([\s\S]*?)<\/span>/)?.[1]));
    const ora = testo(b.match(/text-gray-500 fs-7">([\s\S]*?)<\/span>/)?.[1]);
    if (!gara || nomi.length < 2 || !/ss cormano/i.test(nomi.join(" "))) continue;

    const [pc, po] = punti.map((p) => (/^\d+$/.test(p) ? Number(p) : undefined));
    out.push({
      id: `uisp:${gara}`,
      ente: "UISP",
      campionato,
      campionatoNome: campionato,
      data,
      ora,
      casa: nomi[0],
      ospite: nomi[1],
      pc,
      po,
      stato: pc !== undefined && po !== undefined ? "giocata" : /rinvi|sospes/i.test(testo(b)) ? "rinviata" : "da_giocare",
    });
  }
  return out;
}

// Tutte le gare SS CORMANO dei campionati UISP Milano in cui la società è iscritta.
// Nessun ID scritto a mano: i campionati cambiano ID ogni stagione, il nome ("U17") resta.
export async function partiteUisp(comitato = COMITATO): Promise<Partita[]> {
  const ids = unici([...(await pagina(`/${comitato}`)).matchAll(new RegExp(`href="/${comitato}/(\\d+)"`, "g"))].map((m) => m[1]));

  const nostri = (
    await aGruppi(
      ids,
      async (id) => {
        const html = await pagina(`/${comitato}/${id}/partecipanti`);
        if (!/ss cormano/i.test(html)) return null;
        const nome = testo(html.match(/<title>([^<|]+?)\s+-\s+Partecipanti/)?.[1]) || id;
        return { id, nome };
      },
    )
  ).filter((c): c is { id: string; nome: string } => !!c);

  const out: Partita[] = [];
  for (const c of nostri) {
    const fasi = unici([...(await pagina(`/${comitato}/${c.id}`)).matchAll(new RegExp(`href="/${comitato}/${c.id}/(\\d+)"`, "g"))].map((m) => m[1]));
    for (const f of fasi) {
      const giornate = unici(
        [...(await pagina(`/${comitato}/${c.id}/${f}`)).matchAll(/\?round=(\d+)&amp;roundnumber=(\d+)/g)].map((m) => `?round=${m[1]}&roundnumber=${m[2]}`),
      );
      const pagine = await aGruppi(giornate, (g) => pagina(`/${comitato}/${c.id}/${f}${g}`));
      for (const html of pagine) out.push(...leggiGareUisp(html, c.nome));
    }
  }
  // La stessa gara può comparire in più pagine: tengo una sola copia per ID
  return [...new Map(out.map((p) => [p.id, p])).values()];
}
