import { redis } from "./store";
import { raccogli, type Metriche } from "./metriche";
import { schede, type Scheda } from "./registro";

// Statistiche 3.0 (grilling con l'admin 2026-10-27, .claude/context/statistiche-3.0.md):
// - periodi mese, trimestre, semestre, stagione; la stagione va da settembre ad agosto;
// - crescita = somma dei report mensili (metriche:AAAA-MM), i mesi mancanti si leggono da Meta e si salvano;
// - "cosa tira" = classifiche dal registro dei post (lib/registro.ts): reach Instagram a 7 giorni / follower all'uscita,
//   solo risultati e amichevoli per categoria e sport, solo risultati per CSI / FIP / UISP. Sotto 3 post = pochi dati.

export type Periodo = "mese" | "trimestre" | "semestre" | "stagione";
const LUNGHEZZA: Record<Periodo, number> = { mese: 1, trimestre: 3, semestre: 6, stagione: 12 };
const SETTEMBRE = 8;
const MIN_POST = 3;
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

// Mesi come numero unico (anno * 12 + mese, 0 = gennaio), sempre all'ora di Roma
const indice = (d: Date) => {
  const [y, m] = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }).split("-").map(Number);
  return y * 12 + m - 1;
};
// Mezzanotte di Roma del primo giorno del mese i
const inizio = (i: number) => {
  const utc = Date.UTC(Math.floor(i / 12), i % 12, 1);
  const ore = Number(new Date(utc).toLocaleString("en-US", { timeZone: "Europe/Rome", hour: "numeric", hour12: false }));
  return new Date(utc - ore * 3_600_000);
};
const chiave = (i: number) => `metriche:${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const posizione = (i: number) => (((i % 12) - SETTEMBRE + 12) % 12); // 0 = settembre

export interface Finestra {
  tipo: Periodo;
  da: number; // primo mese
  a: number; // ultimo mese
  fine: Date; // fine vera (oggi se in corso)
  inCorso: boolean;
  nome: string;
}

function nome(tipo: Periodo, da: number, a: number) {
  const anno = (i: number) => Math.floor(i / 12);
  if (tipo === "mese") return `${MESI[da % 12]} ${anno(da)}`;
  if (tipo === "stagione") return `stagione ${anno(da)}/${String(anno(da) + 1).slice(2)}`;
  const fine = `${MESI[a % 12]} ${anno(a)}`;
  return `${tipo} da ${anno(da) === anno(a) ? MESI[da % 12] : `${MESI[da % 12]} ${anno(da)}`} a ${fine}`;
}

// Periodo in corso (per /metriche) o appena chiuso (per il 1° del mese: null se oggi non chiude quel periodo)
export function finestra(tipo: Periodo, adesso = new Date(), chiuso = false): Finestra | null {
  const L = LUNGHEZZA[tipo];
  const ultimo = chiuso ? indice(adesso) - 1 : indice(adesso);
  if (chiuso && (posizione(ultimo) + 1) % L) return null;
  const da = ultimo - (posizione(ultimo) % L);
  const a = chiuso ? ultimo : da + L - 1;
  return { tipo, da, a, fine: chiuso ? new Date(inizio(a + 1).getTime() - 1000) : adesso, inCorso: !chiuso, nome: nome(tipo, da, a) };
}

// Report di un mese: salvato se il mese è finito, altrimenti letto fino a ora
async function mese(i: number, adesso: Date): Promise<Metriche> {
  const finito = inizio(i + 1) <= adesso;
  if (finito) {
    const salvato = await redis.get<Metriche>(chiave(i));
    if (salvato) return salvato;
  }
  const m = await raccogli(inizio(i), finito ? new Date(inizio(i + 1).getTime() - 1000) : adesso);
  if (finito && (m.ig || m.fb)) await redis.set(chiave(i), m);
  return m;
}

// Somma di più mesi. Follower = ultimo valore; un numero mancante in un mese rende il totale "n.d." (mai un totale falso)
function somma(ms: Metriche[]): Metriche {
  const ult = ms[ms.length - 1];
  const tutti = <T>(f: (m: Metriche) => T | undefined) => (ms.every((m) => f(m) !== undefined) ? ms.map((m) => f(m) as T) : undefined);
  const add = (xs?: number[]) => xs?.reduce((s, x) => s + x, 0);
  const out: Metriche = { da: ms[0].da, a: ult.a, errori: ms.flatMap((m) => m.errori) };
  if (ms.every((m) => m.ig)) {
    out.ig = {
      username: ult.ig!.username,
      follower: ult.ig!.follower,
      nuovi: add(tutti((m) => m.ig!.nuovi)),
      copertura: add(tutti((m) => m.ig!.copertura)),
      interazioni: add(tutti((m) => m.ig!.interazioni)),
      visualizzazioni: add(tutti((m) => m.ig!.visualizzazioni)),
      post: ms.reduce((s, m) => s + m.ig!.post, 0),
      top: ms.flatMap((m) => m.ig!.top).sort((x, y) => y.interazioni - x.interazioni).slice(0, 3),
    };
  }
  if (ms.every((m) => m.fb)) {
    const chiavi = Object.keys(ult.fb!.numeri).filter((k) => ms.every((m) => k in m.fb!.numeri));
    out.fb = {
      nome: ult.fb!.nome,
      follower: ult.fb!.follower,
      numeri: Object.fromEntries(chiavi.map((k) => [k, ms.reduce((s, m) => s + m.fb!.numeri[k], 0)])),
      post: ms.reduce((s, m) => s + m.fb!.post, 0),
      top: ms.flatMap((m) => m.fb!.top).sort((x, y) => y.interazioni - x.interazioni).slice(0, 3),
    };
  }
  const sp = tutti((m) => m.sponsor);
  if (sp) out.sponsor = Object.fromEntries(Object.keys(sp[sp.length - 1]).map((k) => [k, sp.reduce((s, x) => s + (x[k] || 0), 0)]));
  return out;
}

export async function crescita(f: Finestra, adesso = new Date()): Promise<Metriche> {
  const ms: Metriche[] = [];
  for (let i = f.da; i <= Math.min(f.a, indice(adesso)); i++) ms.push(await mese(i, adesso));
  const m = { ...somma(ms), periodo: f.nome };
  // Confronto con il periodo uguale prima, solo per periodi chiusi: a metà periodo si confronterebbe un pezzo con un intero
  if (f.inCorso) return m;
  const L = LUNGHEZZA[f.tipo];
  try {
    const prima: Metriche[] = [];
    for (let i = f.da - L; i < f.da; i++) prima.push(await mese(i, adesso));
    if (prima.some((p) => p.ig || p.fb)) Object.assign(m, { prima: somma(prima), primaNome: PRIMA[f.tipo] });
  } catch {
    /* senza confronto */
  }
  return m;
}
const PRIMA: Record<Periodo, string> = { mese: "al mese prima", trimestre: "al trimestre prima", semestre: "al semestre prima", stagione: "alla stagione prima" };

// ---- Cosa tira ----
export interface Gruppo {
  nome: string;
  media: number; // % dei follower raggiunti, media dei post
  post: number;
  pochi: boolean;
}
export interface Classifiche {
  categorie: Gruppo[];
  sport: Gruppo[];
  enti: Gruppo[];
  misurati: number; // post con le statistiche a 7 giorni
  inAttesa: number; // risultati e amichevoli usciti da meno di 7 giorni o senza statistiche
  verdetto: string;
}

const valore = (s: Scheda) => (s.stat?.ig?.reach !== undefined && s.follower ? (s.stat.ig.reach / s.follower) * 100 : undefined);
const sportDi = (c: string) => (c.split("·").pop() || c).trim();

function gruppi(xs: { chiave: string; v: number }[]): Gruppo[] {
  const m = new Map<string, number[]>();
  for (const x of xs) m.set(x.chiave, [...(m.get(x.chiave) || []), x.v]);
  return [...m]
    .map(([nome, vs]) => ({ nome, media: vs.reduce((s, v) => s + v, 0) / vs.length, post: vs.length, pochi: vs.length < MIN_POST }))
    .sort((a, b) => Number(a.pochi) - Number(b.pochi) || b.media - a.media);
}

export async function classifiche(da: Date, a: Date): Promise<Classifiche> {
  const tutte = (await schede(da.getTime(), a.getTime())).filter((s) => s.tipo === "risultato" || s.tipo === "amichevole" || s.tipo === "torneo");
  const ok = tutte.flatMap((s) => {
    const v = valore(s);
    return v === undefined ? [] : [{ s, v }];
  });
  const categorie = gruppi(ok.filter((x) => x.s.categoria).map((x) => ({ chiave: x.s.categoria!, v: x.v })));
  const sport = gruppi(ok.filter((x) => x.s.categoria).map((x) => ({ chiave: sportDi(x.s.categoria!), v: x.v })));
  const enti = gruppi(ok.filter((x) => x.s.tipo === "risultato" && x.s.ente).map((x) => ({ chiave: x.s.ente!, v: x.v })));

  const frasi: string[] = [];
  const primo = categorie.find((g) => !g.pochi);
  if (primo) frasi.push(`Tira di più ${primo.nome}: in media ${primo.media.toFixed(0)}% dei follower raggiunti`);
  const e = enti.filter((g) => !g.pochi);
  if (e.length >= 2) frasi.push(`${e[0].nome} sopra ${e[e.length - 1].nome} del ${Math.round((e[0].media / e[e.length - 1].media - 1) * 100)}%`);
  const verdetto = frasi.length ? `${frasi.join(". ")}.` : `Pochi dati: servono almeno ${MIN_POST} post per gruppo.`;
  return { categorie: categorie.slice(0, 5), sport, enti, misurati: ok.length, inAttesa: tutte.length - ok.length, verdetto };
}

// Invio di un periodo: crescita (dashboard + testo, come il report mensile), poi "Cosa tira" e una riga di verdetto.
// Ritorna gli errori di lettura per l'avviso agli admin.
export async function inviaPeriodo(chatId: number, f: Finestra, adesso = new Date()): Promise<string[]> {
  const { inviaReport } = await import("./metriche");
  const { cosaTira } = await import("./dashboard");
  const { inviaFoto, tg } = await import("./telegram");
  const m = await crescita(f, adesso);
  if (f.inCorso) m.periodo = `${f.nome}, in corso`;
  await inviaReport(chatId, m);
  const c = await classifiche(inizio(f.da), f.fine);
  try {
    await inviaFoto(chatId, await cosaTira(c, m.periodo!), `📊 Cosa tira, ${m.periodo}`);
  } catch (e) {
    m.errori.push(`cosa tira: ${(e as Error).message}`);
  }
  // Le classifiche partono dal registro (26/10/2026): prima non c'è niente da misurare
  const parziale = inizio(f.da) < new Date("2026-10-26T00:00:00+01:00") ? "\nClassifiche dal 26 ottobre 2026, prima i post non erano misurati." : "";
  await tg("sendMessage", { chat_id: chatId, text: `🏆 ${c.verdetto}${parziale}` });
  return m.errori;
}
