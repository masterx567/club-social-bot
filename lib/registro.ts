import { redis } from "./store";
import { programmaChiamata } from "./qstash";

// Registro dei post pubblicati (proposta statistiche, l'admin 2026-10-26).
// Ogni post uscito resta in Redis SENZA scadenza: pub:<id> (scheda) e sorted set "pubblicati" (punteggio = uscita).
// Serve al nuovo report per il direttivo: cosa funziona per tipo di post, misurato sempre dopo lo stesso tempo.
// Dopo 7 giorni QStash chiama api/ig-auto?stat=<id> e qui si leggono gli insight del singolo post.
// Niente qui deve fermare una pubblicazione: chi chiama ignora gli errori.

export const PUBBLICATI = "pubblicati";
const kPub = (id: string) => `pub:${id}`;
const kIds = (id: string) => `igpubid:${id}`; // hash ig / fb: id dei post sui social, scritto da pubblicaIg e pubblicaFb
const GIORNI_STAT = 7;
// QStash (piano gratuito) accetta al massimo 7 giorni di ritardo: un'ora di margine
const RITARDO_MIN = GIORNI_STAT * 24 * 60 - 60;

export type TipoPost = "risultato" | "amichevole" | "torneo" | "post foto" | "evento" | "carosello risultati" | "partite della settimana";

export interface Scheda {
  id: string;
  tipo?: TipoPost;
  categoria?: string;
  ente?: "CSI" | "UISP" | "FIP"; // statistiche 3.0: solo risultati
  follower?: number; // follower Instagram al momento dell'uscita: le classifiche usano reach / follower
  automatico: boolean;
  didascalia: "automatica" | "bozza AI" | "cronaca del coach" | "scritta a mano";
  slide: number;
  video: number;
  approvatoDa?: string;
  inCoda?: number; // ms, momento del ✅
  uscito: number; // ms
  instagram?: { id?: string; link?: string; ok: boolean };
  facebook?: { id?: string; link?: string; ok: boolean };
  stat?: { letto: number; ig?: Record<string, number>; fb?: Record<string, number>; errori?: string[] };
}

// Chiamata da pubblicaIg / pubblicaFb appena il post esiste sul social
export async function salvaIdSocial(id: string, canale: "ig" | "fb", idSocial: string) {
  await redis.hset(kIds(id), { [canale]: idSocial });
  await redis.expire(kIds(id), 30 * 86_400);
}

// Chiamata da esegui() e da riprovaIg(): crea o completa la scheda, programma le statistiche a 7 giorni (una volta)
export async function registraPost(id: string, dati: Omit<Scheda, "id" | "uscito" | "instagram" | "facebook">, esito: { ig?: string | false; fb?: string | false }) {
  const prima = await redis.get<Scheda>(kPub(id));
  const ids = (await redis.hgetall<Record<string, string>>(kIds(id))) || {};
  const canale = (c: "ig" | "fb", v: string | false | undefined, vecchio?: Scheda["instagram"]) =>
    v === undefined ? vecchio : { id: ids[c] || vecchio?.id, link: v || vecchio?.link, ok: v !== false };
  const uscito = prima?.uscito || Date.now();
  const s: Scheda = { ...prima, ...dati, id, uscito, instagram: canale("ig", esito.ig, prima?.instagram), facebook: canale("fb", esito.fb, prima?.facebook) };
  if (prima?.stat) s.stat = prima.stat;
  s.follower = prima?.follower ?? (await followerIg().catch(() => undefined));
  await redis.set(kPub(id), s);
  await redis.zadd(PUBBLICATI, { score: uscito, member: id });
  if (!prima) await programmaChiamata(`${process.env.BASE_URL}/api/ig-auto?stat=${id}`, RITARDO_MIN);
}

const G_FB = "https://graph.facebook.com/v23.0";
const G_IG = "https://graph.instagram.com/v23.0";

async function followerIg(): Promise<number | undefined> {
  const t = await redis.get<{ tipo: string; token: string; igUserId: string }>("ig:token");
  if (!t) return undefined;
  const r = await (await fetch(`${t.tipo === "facebook" ? G_FB : G_IG}/${t.igUserId}?${new URLSearchParams({ fields: "followers_count", access_token: t.token })}`)).json();
  return typeof r.followers_count === "number" ? r.followers_count : undefined;
}

async function insight(url: string, metric: string, token: string) {
  const r = await fetch(`${url}/insights?${new URLSearchParams({ metric, access_token: token })}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.data as any[];
}

// Statistiche del post dopo 7 giorni. Ogni metrica chiesta da sola: Meta le rinomina spesso, quelle che falliscono si saltano.
export async function statistichePost(id: string) {
  const s = await redis.get<Scheda>(kPub(id));
  const t = await redis.get<{ tipo: string; token: string }>("ig:token");
  if (!s || !t) return;
  const errori: string[] = [];
  const stat: NonNullable<Scheda["stat"]> = { letto: Date.now() };
  if (s.instagram?.id) {
    const base = `${t.tipo === "facebook" ? G_FB : G_IG}/${s.instagram.id}`;
    stat.ig = {};
    for (const m of ["reach", "total_interactions", "saved", "shares", "views"]) {
      try {
        const v = (await insight(base, m, t.token))[0]?.values?.[0]?.value;
        if (typeof v === "number") stat.ig[m] = v;
      } catch (e) {
        errori.push(`IG ${m}: ${(e as Error).message}`);
      }
    }
  }
  if (s.facebook?.id && t.tipo === "facebook") {
    stat.fb = {};
    try {
      const v = (await insight(`${G_FB}/${s.facebook.id}`, "post_reactions_by_type_total", t.token))[0]?.values?.[0]?.value || {};
      stat.fb.reazioni = Object.values(v as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0);
    } catch (e) {
      errori.push(`FB reazioni: ${(e as Error).message}`);
    }
    try {
      const r = await (await fetch(`${G_FB}/${s.facebook.id}?${new URLSearchParams({ fields: "shares", access_token: t.token })}`)).json();
      stat.fb.condivisioni = r.shares?.count || 0;
    } catch (e) {
      errori.push(`FB condivisioni: ${(e as Error).message}`);
    }
  }
  if (errori.length) stat.errori = errori;
  await redis.set(kPub(id), { ...s, stat });
}

export async function schede(da: number, a: number): Promise<Scheda[]> {
  const ids = await redis.zrange<string[]>(PUBBLICATI, da, a, { byScore: true });
  if (!ids.length) return [];
  return ((await redis.mget<(Scheda | null)[]>(...ids.map(kPub))) || []).filter((x): x is Scheda => !!x);
}
