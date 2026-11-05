import { redis } from "./store";
import { dashboard, totali } from "./dashboard";
import { inviaFoto, tg } from "./telegram";

// Statistiche Instagram + Pagina Facebook (decisione 2026-10-08): /metriche a richiesta e report il 1° del mese
// nell'argomento 📊. Ogni report mensile viene salvato in Redis (metriche:AAAA-MM) per uno storico futuro.
// Serve il login Facebook con instagram_manage_insights e read_insights.
// Meta cambia spesso i nomi delle metriche: ognuna è chiesta da sola, quelle che falliscono si saltano.

const G = "https://graph.facebook.com/v23.0";

interface Token {
  tipo: string;
  token: string;
  igUserId: string;
  username: string;
  pageId?: string;
  pageName?: string;
}

interface Post {
  testo: string;
  link: string;
  interazioni: number;
  copertura?: number;
}

export interface Metriche {
  da: string;
  a: string;
  ig?: { username: string; follower: number; nuovi?: number; copertura?: number; interazioni?: number; visualizzazioni?: number; post: number; top: Post[] };
  fb?: { nome: string; follower: number; numeri: Record<string, number>; post: number; top: Post[] };
  sponsor?: Record<string, number>; // click sul sito verso gli sponsor nel periodo
  prima?: Metriche; // periodo precedente, per il confronto (report mensile e /metriche)
  primaNome?: string; // come chiamare il periodo di confronto, predefinito "al mese prima"
  periodo?: string; // 3.0: nome del periodo nel titolo, es. "ottobre 2026", "stagione 2026/27"
  errori: string[];
}

// Sponsor con link contato dal sito: example.org -> BASE_URL/api/setup?vai=<nome> -> sito sponsor
export const SPONSOR: Record<string, string> = { sponsor: "https://example.org/" };

async function clickSponsor(da: Date, a: Date): Promise<Record<string, number>> {
  const g = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
  const out: Record<string, number> = {};
  for (const nome of Object.keys(SPONSOR)) {
    const giorni = (await redis.hgetall<Record<string, number>>(`sponsor:click:${nome}`)) || {};
    out[nome] = Object.entries(giorni).reduce((s, [d, v]) => (d >= g(da) && d <= g(a) ? s + Number(v) : s), 0);
  }
  return out;
}

async function get<T = any>(path: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`${G}/${path}?${new URLSearchParams(params)}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

const unix = (d: Date) => String(Math.floor(d.getTime() / 1000));
const somma = (vals: { value: number }[] = []) => vals.reduce((s, v) => s + (Number(v.value) || 0), 0);
const breve = (s = "") => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 45 ? `${t.slice(0, 45)}…` : t || "(senza testo)";
};

async function instagram(t: Token, da: Date, a: Date, errori: string[]): Promise<Metriche["ig"]> {
  const acc = await get<{ followers_count: number }>(t.igUserId, { fields: "followers_count", access_token: t.token });
  const base = { period: "day", since: unix(da), until: unix(a), access_token: t.token };

  // Instagram accetta al massimo 30 giorni tra since e until (2026-10-27: i mesi da 31 giorni fallivano).
  // Periodi più lunghi a pezzi di 30 giorni, sommati: per gli account raggiunti è una somma, non persone uniche.
  const pezzi: [Date, Date][] = [];
  for (let x = da.getTime(); x < a.getTime(); x += 30 * 86_400_000) pezzi.push([new Date(x), new Date(Math.min(a.getTime(), x + 30 * 86_400_000))]);
  const totale = async (metric: string) => {
    try {
      let tot = 0;
      for (const [p, q] of pezzi) {
        const j = await get<{ data: any[] }>(`${t.igUserId}/insights`, { ...base, since: unix(p), until: unix(q), metric, metric_type: "total_value" });
        tot += Number(j.data[0]?.total_value?.value ?? 0);
      }
      return tot;
    } catch (e) {
      errori.push(`IG ${metric}: ${(e as Error).message}`);
      return undefined;
    }
  };
  let nuovi: number | undefined;
  // follower_count esiste solo negli ultimi 30 giorni (escluso oggi): si chiede la parte del periodo che ci sta dentro.
  // Il 1° del mese per un mese da 31 giorni manca il primo giorno. Per i mesi vecchi non si chiede (niente errore inutile)
  const limite = Date.now() - 30 * 86_400_000 + 3_600_000;
  // Se ne resterebbe fuori più di un paio di giorni il numero sarebbe falso: meglio "n.d."
  if (da.getTime() >= limite - 2 * 86_400_000) try {
    const j = await get<{ data: any[] }>(`${t.igUserId}/insights`, { ...base, since: unix(new Date(Math.max(da.getTime(), limite))), metric: "follower_count" });
    nuovi = somma(j.data[0]?.values);
  } catch (e) {
    errori.push(`IG follower_count: ${(e as Error).message}`);
  }

  const media = await get<{ data: any[] }>(`${t.igUserId}/media`, {
    fields: "id,caption,timestamp,permalink,like_count,comments_count",
    limit: "100",
    access_token: t.token,
  });
  const nelPeriodo = media.data.filter((m) => new Date(m.timestamp) >= da && new Date(m.timestamp) <= a);
  const post: Post[] = [];
  for (const m of nelPeriodo) {
    let interazioni = (m.like_count || 0) + (m.comments_count || 0);
    let copertura: number | undefined;
    try {
      const j = await get<{ data: any[] }>(`${m.id}/insights`, { metric: "reach,total_interactions", access_token: t.token });
      const v = (n: string) => j.data.find((x) => x.name === n)?.values?.[0]?.value;
      copertura = v("reach");
      interazioni = v("total_interactions") ?? interazioni;
    } catch {
      /* post senza statistiche (es. molto recente): bastano like + commenti */
    }
    post.push({ testo: breve(m.caption), link: m.permalink, interazioni, copertura });
  }
  return {
    username: t.username,
    follower: acc.followers_count,
    nuovi,
    copertura: await totale("reach"),
    interazioni: await totale("total_interactions"),
    visualizzazioni: await totale("views"),
    post: post.length,
    top: post.sort((x, y) => y.interazioni - x.interazioni).slice(0, 3),
  };
}

async function facebook(t: Token, da: Date, a: Date, errori: string[]): Promise<Metriche["fb"]> {
  const pag = await get<{ followers_count: number; name: string }>(t.pageId!, { fields: "followers_count,name", access_token: t.token });
  const numeri: Record<string, number> = {};
  // Per ogni numero più nomi possibili, dal più recente: Meta ha ritirato page_impressions_* (2025, "valid insights metric")
  const candidati: Record<string, string[]> = {
    copertura: ["page_total_media_view_unique", "page_impressions_unique"],
    visualizzazioni: ["page_media_view", "page_impressions"],
    interazioni: ["page_post_engagements"],
    "nuovi follower": ["page_daily_follows_unique", "page_follows"],
  };
  for (const [nome, metriche] of Object.entries(candidati)) {
    const falliti: string[] = [];
    for (const metric of metriche) {
      try {
        const j = await get<{ data: any[] }>(`${t.pageId}/insights`, { metric, period: "day", since: unix(da), until: unix(a), access_token: t.token });
        numeri[nome] = somma(j.data[0]?.values);
        break;
      } catch (e) {
        falliti.push(`${metric}: ${(e as Error).message}`);
      }
    }
    if (!(nome in numeri)) errori.push(`FB ${nome} (${falliti.join(" | ")})`);
  }
  // reactions/comments per post vogliono pages_read_user_content (non attivabile, "Invalid Scopes"):
  // si usano le statistiche del post (read_insights). Interazioni FB per post = reazioni + condivisioni.
  const posts = await get<{ data: any[] }>(`${t.pageId}/published_posts`, {
    fields: "message,created_time,permalink_url,shares,insights.metric(post_reactions_by_type_total)",
    since: unix(da),
    until: unix(a),
    limit: "100",
    access_token: t.token,
  }).catch((e) => {
    errori.push(`FB post: ${(e as Error).message}`);
    return { data: [] as any[] };
  });
  const post: Post[] = posts.data.map((p) => ({
    testo: breve(p.message),
    link: p.permalink_url,
    interazioni:
      Object.values((p.insights?.data?.[0]?.values?.[0]?.value || {}) as Record<string, number>).reduce((s, v) => s + (Number(v) || 0), 0) +
      (p.shares?.count || 0),
  }));
  return {
    nome: pag.name,
    follower: pag.followers_count,
    numeri,
    post: post.length,
    top: post.sort((x, y) => y.interazioni - x.interazioni).slice(0, 3),
  };
}

export async function raccogli(da: Date, a: Date): Promise<Metriche> {
  const t = await redis.get<Token>("ig:token");
  const out: Metriche = { da: da.toISOString(), a: a.toISOString(), errori: [] };
  out.sponsor = await clickSponsor(da, a).catch(() => undefined);
  if (!t || t.tipo !== "facebook") {
    out.errori.push("Meta non collegato con il login Facebook");
    return out;
  }
  await Promise.all([
    instagram(t, da, a, out.errori).then((x) => (out.ig = x)).catch((e) => out.errori.push(`Instagram: ${e.message}`)),
    facebook(t, da, a, out.errori).then((x) => (out.fb = x)).catch((e) => out.errori.push(`Facebook: ${e.message}`)),
  ]);
  return out;
}

const n = (x?: number) => (x === undefined ? "n.d." : x.toLocaleString("it-IT"));
const giorno = (iso: string) => new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short", timeZone: "Europe/Rome" });

export function testo(m: Metriche): string {
  const r: string[] = [`📊 Statistiche ${m.periodo ? `${m.periodo}, ` : ""}dal ${giorno(m.da)} al ${giorno(m.a)}`];
  const top = (ps: Post[]) =>
    ps.map((p, i) => `${i + 1}. ${p.testo} · ${n(p.interazioni)} interazioni${p.copertura ? ` · ${n(p.copertura)} raggiunti` : ""}\n${p.link}`);
  // Prima i numeri combinati (richiesta 2026-10-08), poi i singoli canali
  const t = totali(m);
  // Confronto col mese prima (2.0): "▲ 12%" accanto al numero, solo se il mese prima c'è
  const p = m.prima && totali(m.prima);
  const vs = (ora?: number, prima?: number) => {
    if (ora === undefined || !prima) return "";
    const d = Math.round(((ora - prima) / prima) * 100);
    const nome = m.primaNome || "al mese prima";
    return d === 0 ? ` (uguale ${nome})` : ` (${d > 0 ? "▲" : "▼"} ${Math.abs(d)}% rispetto ${nome})`;
  };
  if (m.ig && m.fb) {
    r.push(
      "",
      "🔗 Totale Instagram + Facebook",
      `• Follower: ${n(t.follower)}${t.nuovi !== undefined ? ` (+${n(t.nuovi)})` : ""}`,
      `• Account raggiunti: ${n(t.copertura)}${vs(t.copertura, p?.copertura)}`,
      `• Interazioni: ${n(t.interazioni)}${vs(t.interazioni, p?.interazioni)}`,
      `• Post pubblicati: ${t.post}${vs(t.post, p?.post)}`,
    );
  }
  if (m.ig) {
    r.push(
      "",
      `📸 Instagram @${m.ig.username}`,
      `• Follower: ${n(m.ig.follower)}${m.ig.nuovi !== undefined ? ` (+${n(m.ig.nuovi)})` : ""}`,
      `• Account raggiunti: ${n(m.ig.copertura)}`,
      `• Interazioni: ${n(m.ig.interazioni)}`,
      ...(m.ig.visualizzazioni !== undefined ? [`• Visualizzazioni: ${n(m.ig.visualizzazioni)}`] : []),
      `• Post pubblicati: ${m.ig.post}`,
    );
    if (m.ig.top.length) r.push("Migliori post:", ...top(m.ig.top));
  }
  if (m.fb) {
    r.push("", `👍 Facebook ${m.fb.nome}`, `• Follower: ${n(m.fb.follower)}`);
    for (const [k, v] of Object.entries(m.fb.numeri)) r.push(`• ${k[0].toUpperCase()}${k.slice(1)}: ${n(v)}`);
    r.push(`• Post pubblicati: ${m.fb.post}`);
    if (m.fb.top.length) r.push("Migliori post:", ...top(m.fb.top));
  }
  if (m.sponsor && Object.keys(m.sponsor).length)
    r.push("", "🤝 Click dal sito agli sponsor", ...Object.entries(m.sponsor).map(([k, v]) => `• ${k[0].toUpperCase()}${k.slice(1)}: ${n(v)}${vs(v, m.prima?.sponsor?.[k])}`));
  if (!m.ig && !m.fb) r.push("", "Nessun dato disponibile.");
  return r.join("\n");
}

// Report del mese precedente, salvato per lo storico. Da chiamare il 1° del mese.
export async function reportMensile(): Promise<Metriche> {
  const oggi = new Date();
  const a = new Date(Date.UTC(oggi.getUTCFullYear(), oggi.getUTCMonth(), 1) - 1000);
  const da = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
  const m = await raccogli(da, a);
  await redis.set(`metriche:${da.toISOString().slice(0, 7)}`, m);
  const meseprima = new Date(Date.UTC(da.getUTCFullYear(), da.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const prima = await redis.get<Metriche>(`metriche:${meseprima}`).catch(() => null);
  return prima ? { ...m, prima } : m;
}

// Invio: prima la dashboard (immagine), poi il testo con i link ai post. Se l'immagine fallisce, resta il testo.
export async function inviaReport(chatId: number, m: Metriche) {
  try {
    await inviaFoto(chatId, await dashboard(m), `📊 Statistiche social${m.periodo ? `, ${m.periodo}` : ""}`);
  } catch (e) {
    m.errori.push(`dashboard: ${(e as Error).message}`);
  }
  await tg("sendMessage", { chat_id: chatId, text: testo(m), link_preview_options: { is_disabled: true } });
}
