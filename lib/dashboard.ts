// @vercel/og è solo ESM: col bot compilato in CommonJS un import statico fa crashare TUTTE le funzioni all'avvio
// (ERR_REQUIRE_ESM, 2026-10-08). Si carica solo quando serve; new Function evita che TypeScript lo trasformi in require.
// I file del pacchetto sono inclusi a mano in vercel.json (includeFiles), perché così Vercel non li vede.
const importEsm = new Function("s", "return import(s)") as (s: string) => Promise<any>;
import type { Metriche } from "./metriche";

// Immagine "dashboard" delle statistiche (richiesta 2026-10-08: prima i numeri combinati, poi i singoli canali).
// @vercel/og (satori) porta con sé il font: su Vercel non ci sono font di sistema per disegnare testo con sharp.

const VERDE = "#0a2a1a";
const VERDE2 = "#123d27";
const GIALLO = "#e9c85a";
const BIANCO = "#ffffff";
const GRIGIO = "#a8c3b3";

type El = { type: string; props: Record<string, unknown> };
const div = (style: Record<string, unknown>, ...children: (El | string)[]): El => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

const num = (x?: number) => (x === undefined ? "n.d." : x.toLocaleString("it-IT"));

export interface Totali {
  follower?: number;
  nuovi?: number;
  copertura?: number;
  interazioni?: number;
  post: number;
}

// Somma dei due canali; un numero mancante su un canale rende la somma "n.d." per non mostrare un totale falso
export function totali(m: Metriche): Totali {
  const add = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : a + b);
  const ig = m.ig;
  const fb = m.fb;
  return {
    follower: add(ig?.follower, fb?.follower),
    nuovi: add(ig?.nuovi, fb?.numeri["nuovi follower"]),
    copertura: add(ig?.copertura, fb?.numeri.copertura),
    interazioni: add(ig?.interazioni, fb?.numeri.interazioni),
    post: (ig?.post || 0) + (fb?.post || 0),
  };
}

// grande = tessere dei totali, affiancate in riga (si dividono la larghezza);
// piccole = una sotto l'altra nelle colonne (con flex:1 in colonna si schiacciavano a altezza zero)
// delta: variazione sul periodo prima (2026-10-20), piccola accanto al numero
const delta = (ora?: number, prima?: number) => {
  if (ora === undefined || !prima) return "";
  const d = Math.round(((ora - prima) / prima) * 100);
  return d === 0 ? "=" : `${d > 0 ? "+" : "−"}${Math.abs(d)}%`; // ▲▼ non ci sono nel font della grafica
};
const tessera = (etichetta: string, valore: string, grande = false, var_ = "") =>
  div(
    {
      flexDirection: "column",
      backgroundColor: VERDE2,
      borderRadius: 18,
      padding: grande ? "22px 24px" : "8px 18px",
      margin: 6,
      ...(grande ? { flex: 1 } : { flexShrink: 0 }),
    },
    div({ fontSize: grande ? 22 : 18, color: GRIGIO, letterSpacing: 1 }, etichetta.toUpperCase()),
    div(
      { alignItems: "flex-end", marginTop: 6 },
      div({ fontSize: grande ? 58 : 32, color: grande ? GIALLO : BIANCO, fontWeight: 700 }, valore),
      ...(var_
        ? [div({ fontSize: grande ? 26 : 22, color: var_.startsWith("−") ? ROSSO : var_ === "=" ? GRIGIO : VERDE_SU, marginLeft: 14, marginBottom: grande ? 10 : 6 }, var_)]
        : []),
    ),
  );
const ROSSO = "#ff8a80";
const VERDE_SU = "#7ee08a";

const colonna = (titolo: string, righe: [string, string, string?][]) =>
  div(
    { flexDirection: "column", flex: 1, margin: "0 6px" },
    div({ fontSize: 24, color: GIALLO, fontWeight: 700, margin: "6px 6px 4px", letterSpacing: 2 }, titolo),
    ...righe.map(([e, v, d]) => tessera(e, v, false, d)),
  );

const giorno = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short", timeZone: "Europe/Rome" });

export async function dashboard(m: Metriche): Promise<Buffer> {
  const t = totali(m);
  const p = m.prima;
  const tp = p && totali(p);
  const top = [
    ...(m.ig?.top || []).map((p) => ({ ...p, canale: "IG" })),
    ...(m.fb?.top || []).map((p) => ({ ...p, canale: "FB" })),
  ]
    .sort((a, b) => b.interazioni - a.interazioni)
    .slice(0, 3);

  const el = div(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: VERDE, padding: 44, fontFamily: "sans-serif" },
    div({ fontSize: 46, color: BIANCO, fontWeight: 700 }, "STATISTICHE SOCIAL"),
    div({ fontSize: 26, color: GRIGIO, marginBottom: 22 }, `Società Sportiva Cormano · ${m.periodo || `dal ${giorno(m.da)} al ${giorno(m.a)}`}${p ? ` · % rispetto ${m.primaNome || "al mese prima"}` : ""}`),

    div({ fontSize: 24, color: GIALLO, fontWeight: 700, margin: "0 6px 4px", letterSpacing: 2 }, "TOTALE INSTAGRAM + FACEBOOK"),
    div({}, tessera("Follower", num(t.follower), true), tessera("Nuovi follower", t.nuovi === undefined ? "n.d." : `+${num(t.nuovi)}`, true, delta(t.nuovi, tp?.nuovi))),
    div({}, tessera("Account raggiunti", num(t.copertura), true, delta(t.copertura, tp?.copertura)), tessera("Interazioni", num(t.interazioni), true, delta(t.interazioni, tp?.interazioni))),

    div(
      { marginTop: 18 },
      colonna("INSTAGRAM", [
        ["Follower", num(m.ig?.follower)],
        ["Raggiunti", num(m.ig?.copertura), delta(m.ig?.copertura, p?.ig?.copertura)],
        ["Interazioni", num(m.ig?.interazioni), delta(m.ig?.interazioni, p?.ig?.interazioni)],
        ["Visualizzazioni", num(m.ig?.visualizzazioni), delta(m.ig?.visualizzazioni, p?.ig?.visualizzazioni)],
        ["Post", num(m.ig?.post), delta(m.ig?.post, p?.ig?.post)],
      ]),
      colonna("FACEBOOK", [
        ["Follower", num(m.fb?.follower)],
        ["Raggiunti", num(m.fb?.numeri.copertura), delta(m.fb?.numeri.copertura, p?.fb?.numeri.copertura)],
        ["Interazioni", num(m.fb?.numeri.interazioni), delta(m.fb?.numeri.interazioni, p?.fb?.numeri.interazioni)],
        ["Visualizzazioni", num(m.fb?.numeri.visualizzazioni), delta(m.fb?.numeri.visualizzazioni, p?.fb?.numeri.visualizzazioni)],
        ["Post", num(m.fb?.post), delta(m.fb?.post, p?.fb?.post)],
      ]),
    ),

    div({ fontSize: 24, color: GIALLO, fontWeight: 700, margin: "20px 6px 6px", letterSpacing: 2 }, "MIGLIORI POST"),
    ...(top.length
      ? top.map((p, i) =>
          div(
            { fontSize: 24, color: BIANCO, margin: "4px 6px", alignItems: "center" },
            div({ color: GIALLO, fontWeight: 700, width: 70 }, `${i + 1}. ${p.canale}`),
            div({ flex: 1, overflow: "hidden" }, p.testo.replace(/[\p{Extended_Pictographic}️‍]/gu, "").trim().slice(0, 40)),
            div({ color: GIALLO, marginLeft: 12 }, `${num(p.interazioni)}`),
          ),
        )
      : [div({ fontSize: 22, color: GRIGIO, margin: "4px 6px" }, "Nessun post nel periodo")]),
  );

  const { ImageResponse } = await importEsm("@vercel/og");
  const r = new ImageResponse(el as any, { width: 1080, height: 1350 });
  return Buffer.from(await r.arrayBuffer());
}

// ---- 3.0: "Cosa tira" (statistiche 2026-10-27) ----
// Barre = % dei follower raggiunti in media dai post del gruppo (reach Instagram a 7 giorni / follower all'uscita).
// Gruppi con meno di 3 post in grigio, "pochi dati".
type GruppoBarra = { nome: string; media: number; post: number; pochi: boolean };

const barre = (titolo: string, gs: GruppoBarra[], vuoto: string) => {
  const max = Math.max(1, ...gs.map((g) => g.media));
  return div(
    { flexDirection: "column", margin: "10px 6px 4px" },
    div({ fontSize: 24, color: GIALLO, fontWeight: 700, marginBottom: 8, letterSpacing: 2 }, titolo),
    ...(gs.length
      ? gs.map((g) =>
          div(
            { alignItems: "center", margin: "5px 0" },
            div({ width: 290, fontSize: 24, color: g.pochi ? GRIGIO : BIANCO }, g.nome),
            div(
              { flex: 1, height: 34, backgroundColor: VERDE2, borderRadius: 10 },
              div({ width: `${Math.max(3, (g.media / max) * 100)}%`, height: 34, backgroundColor: g.pochi ? GRIGIO : GIALLO, borderRadius: 10 }, ""),
            ),
            div({ width: 230, justifyContent: "flex-end", fontSize: 22, color: g.pochi ? GRIGIO : BIANCO }, `${g.media.toFixed(0)}% · ${g.post} post${g.pochi ? " · pochi" : ""}`),
          ),
        )
      : [div({ fontSize: 22, color: GRIGIO }, vuoto)]),
  );
};

export async function cosaTira(c: { categorie: GruppoBarra[]; sport: GruppoBarra[]; enti: GruppoBarra[]; misurati: number; inAttesa: number }, periodo: string): Promise<Buffer> {
  const el = div(
    { flexDirection: "column", width: "100%", height: "100%", backgroundColor: VERDE, padding: 44, fontFamily: "sans-serif" },
    div({ fontSize: 46, color: BIANCO, fontWeight: 700 }, "COSA TIRA"),
    div({ fontSize: 26, color: GRIGIO, marginBottom: 10 }, `Società Sportiva Cormano · ${periodo}`),
    div({ fontSize: 22, color: GRIGIO, marginBottom: 14 }, `% dei follower Instagram raggiunti in media, a 7 giorni · ${c.misurati} post misurati${c.inAttesa ? `, ${c.inAttesa} in attesa` : ""}`),
    barre("PRIME 5 CATEGORIE", c.categorie, "Nessun risultato misurato nel periodo"),
    barre("SPORT", c.sport, "Nessun risultato misurato nel periodo"),
    barre("CAMPIONATO (SOLO RISULTATI)", c.enti, "Nessun risultato con campionato nel periodo"),
  );
  const { ImageResponse } = await importEsm("@vercel/og");
  const r = new ImageResponse(el as any, { width: 1080, height: 1350 });
  return Buffer.from(await r.arrayBuffer());
}
