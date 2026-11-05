import { SPORT, etichetta } from "./categorie";
import { redis } from "./store";

export interface Partita {
  id: string; // ente + codice gara del portale, es. "csi:2026113AA0205": chiave stabile anche se la partita viene spostata
  ente: "CSI" | "UISP" | "FIP";
  campionato: string; // id del campionato sul portale
  campionatoNome: string;
  data: string; // "2026-09-24", vuota se il portale non l'ha ancora fissata
  ora: string;
  casa: string; // nomi come scritti sul portale
  ospite: string;
  logoCasa?: string; // URL del logo società sul portale (solo CSI)
  logoOspite?: string;
  pc?: number; // punti casa
  po?: number; // punti ospite
  stato: "da_giocare" | "giocata" | "rinviata";
}

// Campionato del portale -> categoria del bot. Una riga per campionato, da aggiornare a ogni stagione:
// un campionato sconosciuto non blocca il carosello, arriva un avviso all'admin.
// CSI: id del campionato. FIP e UISP: nome del campionato, che resta uguale da una stagione all'altra.
const CAMPIONATI: Record<string, [sport: string, categoria: string]> = {
  "CSI:113": ["CALCIO", "OPEN ECCELLENZA"],
  "CSI:158": ["CALCIO", "UNDER 9"], // "Under 9 a 5", calcio a 5, dal 2026-10-14
  "CSI:359": ["VOLLEY", "UNDER 17"],
  "CSI:310": ["VOLLEY", "UNDER 14"],
  "CSI:332": ["VOLLEY", "UNDER 13"],
  "CSI:336": ["VOLLEY", "UNDER 10"],
  "CSI:506": ["BASKET", "UNDER 14"],
  "CSI:507": ["BASKET", "UNDER 12"],
  "CSI:522": ["BASKET", "UNDER 10"],
  "FIP:Divisione regionale 2": ["BASKET", "DR2"],
  "UISP:U14": ["BASKET", "UNDER 14"],
  "UISP:U15": ["BASKET", "UNDER 15"],
  "UISP:U16 F": ["BASKET", "UNDER 16 FEMM."],
  "UISP:U17": ["BASKET", "UNDER 17"],
};

// Campionati nuovi confermati dall'admin con il bottone (2026-10-21): hash Redis "campionati", chiave ente:campionato.
// Si ricaricano a ogni partiteTra, così categoriaDi resta sincrona.
let confermati: Record<string, [string, string]> = {};
export async function caricaCampionati() {
  confermati = (await redis.hgetall<Record<string, [string, string]>>("campionati")) || {};
}

export function categoriaDi(p: Partita): { sport: string; categoria: string; etichetta: string } | null {
  const k = `${p.ente}:${p.campionato}`;
  const c = CAMPIONATI[k] ?? confermati[k];
  return c ? { sport: c[0], categoria: c[1], etichetta: etichetta(c[0], c[1]) } : null;
}

// Ordine del carosello: sport e categorie nell'ordine di categorie.ts
export function ordine(p: Partita): number {
  const c = categoriaDi(p);
  if (!c) return 9999;
  const sport = Object.keys(SPORT);
  return sport.indexOf(c.sport) * 100 + SPORT[c.sport].indexOf(c.categoria);
}

export const salvaPartite = (ps: Partita[]) =>
  ps.length ? redis.hset("partite", Object.fromEntries(ps.map((p) => [p.id, p]))) : Promise.resolve(0);

// Toglie dall'archivio le gare di un ente che il portale non restituisce più
export async function togliSparite(ente: string, ps: Partita[]) {
  const ids = new Set(ps.map((p) => p.id));
  const tutte = Object.values((await redis.hgetall<Record<string, Partita>>("partite")) || {});
  const via = tutte.filter((p) => p.ente === ente && !ids.has(p.id)).map((p) => p.id);
  if (via.length) await redis.hdel("partite", ...via);
  return via.length;
}

export async function partiteTra(da: string, a: string): Promise<Partita[]> {
  await caricaCampionati();
  const tutte = Object.values((await redis.hgetall<Record<string, Partita>>("partite")) || {});
  return tutte.filter((p) => p.data && p.data >= da && p.data <= a);
}

// ---- Nomi squadra nel box: massimo 13 caratteri (misurato sul font del template) ----

export const MAX_NOME = 13;

// Parole che sul portale allungano il nome senza dire niente a chi legge
// (lo sport è già nel box categoria)
const RUMORE = /\b(A\.?S\.?D\.?|S\.?S\.?D\.?|A\.?S\.?|U\.?S\.?|G\.?S\.?|POL\.?|POLISPORTIVA|BASKET|PALLACANESTRO|PALLAVOLO|VOLLEY)(?=\s|$)/g;

// Categoria ("U10") o colore ("BLU", "GIALLA") distinguono le squadre della stessa società:
// la società è quello che viene prima. "ASO CERNUSCO U10 BLU" -> "ASO CERNUSCO"
const CATEGORIA = /\sU\d{1,2}\b.*$/;
const COLORE =
  /(\s+(BLU|BLUE|AZZ\.?|AZZURR[AO]|BIANC[AO]|ROSS[AO]|GIALL[AO]|VERDE|NER[AO]|ARANCIO(NE)?|VIOLA|GRIGI[AO]|ORO|ARGENTO|AMARANTO|GRANATA|CELESTE))+$/;

export const pulisciNome = (n: string) => {
  const base = n.toUpperCase().replace(CATEGORIA, "").replace(COLORE, "");
  return (base.trim() || n.toUpperCase()).replace(RUMORE, " ").replace(/\s+/g, " ").trim();
};

export const setAlias = (portale: string, corto: string) => redis.hset("alias", { [portale.toUpperCase()]: corto.toUpperCase() });

// null = nome troppo lungo e senza alias: la riga non si pubblica finché qualcuno non lo decide
export async function nomeBreve(portale: string): Promise<string | null> {
  if (/linea\s*verde/i.test(portale)) return "SS CORMANO";
  const alias = await redis.hget<string>("alias", portale.toUpperCase());
  if (alias) return alias;
  const pulito = pulisciNome(portale);
  return pulito.length <= MAX_NOME ? pulito : null;
}

// Nome in grafica anche se lungo e senza alias: sulla copertina risultato si vede solo quando manca il logo
export const nomeGrafica = async (portale: string) => (await nomeBreve(portale)) ?? pulisciNome(portale);

// /risultato (2026-10-20): partite di SS Cormano degli ultimi giorni tra cui scegliere, la più recente prima
export async function partiteRecenti(giorni = 7): Promise<Partita[]> {
  const iso = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
  const ps = await partiteTra(iso(new Date(Date.now() - giorni * 86_400_000)), iso(new Date()));
  return ps
    .filter((p) => p.stato !== "rinviata" && categoriaDi(p) && /linea\s*verde/i.test(`${p.casa} ${p.ospite}`))
    .sort((a, b) => b.data.localeCompare(a.data) || ordine(a) - ordine(b))
    .slice(0, 12);
}
