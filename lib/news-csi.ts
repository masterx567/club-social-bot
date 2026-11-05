import dns from "node:dns";
import { redis } from "./store";
import { bottoneNews, bottoneSubito, chiaveNews, importante, kSettimana, salvaBottone, salvaNews } from "./newsletter";
import { v3 } from "./prova";
import { tg } from "./telegram";

// Node in locale prova IPv6 e va in timeout sul server CSI; su Vercel non cambia nulla
dns.setDefaultResultOrder("ipv4first");

const BASE = "https://www.csi.milano.it";
const VISTI = "csi:news:visti"; // set Redis degli URL già pubblicati

export interface News {
  url: string;
  titolo: string;
  data?: string;
  sottotitolo?: string;
  testo?: string;
  img?: string;
}

const pulisci = (s?: string) =>
  s
    ?.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    // Lettere accentate e simboli scritti come entità HTML (es. "societ&agrave;")
    .replace(/&([aeiou])(grave|acute);/gi, (_, l: string, t: string) => l.normalize("NFD") + (t === "grave" ? "̀" : "́"))
    .normalize("NFC")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/&#8230;|&hellip;/g, "…")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;

// La home non ha RSS: ogni notizia è un <article class="item ..."> con data, h1, h2, abstract e immagine
// Il sito CSI ogni tanto non risponde (2026-10-09: cron fallito, un minuto dopo ok): 3 tentativi prima di arrendersi
export async function leggiHome(): Promise<News[]> {
  let ultimo: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const news = await leggiHomeUnaVolta();
      if (news.length) return news;
      ultimo = new Error("Home CSI: nessuna notizia trovata, struttura pagina cambiata?");
    } catch (e) {
      ultimo = e;
    }
    if (i < 2) await new Promise((ok) => setTimeout(ok, 8000));
  }
  throw ultimo;
}

async function leggiHomeUnaVolta(): Promise<News[]> {
  const r = await fetch(BASE + "/", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`CSI home HTTP ${r.status}`);
  const html = await r.text();

  const news: News[] = [];
  for (const [, blocco] of html.matchAll(/<article class="item[^"]*">([\s\S]*?)<\/article>/g)) {
    const h1 = blocco.match(/<h1><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h1>/);
    if (!h1) continue;
    const img = blocco.match(/<img src="([^"]+)"/)?.[1];
    news.push({
      url: new URL(h1[1], BASE).href,
      titolo: pulisci(h1[2])!,
      data: pulisci(blocco.match(/<p class="date">([\s\S]*?)<\/p>/)?.[1]),
      sottotitolo: pulisci(blocco.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]),
      testo: pulisci(blocco.match(/<p class="abstract">([\s\S]*?)<\/p>/)?.[1] ?? blocco.match(/<\/h1>\s*<p>([\s\S]*?)<\/p>/)?.[1]),
      img: img && new URL(img, BASE).href,
    });
  }
  return news;
}

// Didascalia della foto: massimo 1024 caratteri. Data e link restano sempre interi in fondo
// (prima il taglio a 1024 poteva troncare il link nelle notizie lunghe); se serve si accorcia il testo.
export const didascalia = (n: News) => {
  const coda = [n.data && `🗓 ${n.data}`, n.url].filter(Boolean).join("\n\n");
  const corpo = [`📰 ${n.titolo}`, n.sottotitolo, n.testo].filter(Boolean).join("\n\n");
  const spazio = 1024 - coda.length - 2;
  return `${corpo.length > spazio ? `${corpo.slice(0, spazio - 1)}…` : corpo}\n\n${coda}`;
};

// "24.09.2026" → "20260924", per ordinare le notizie dalla più vecchia alla più recente
const ordine = (n: News) => n.data?.split(".").reverse().join("") ?? "";

// Pubblica nel gruppo solo le notizie mai viste, la più recente per ultima (in fondo alla chat)
export async function pubblicaNuove(chatId: number): Promise<number> {
  const news = await leggiHome();
  if (!news.length) throw new Error("Home CSI: nessuna notizia trovata, struttura pagina cambiata?");
  news.sort((a, b) => ordine(a).localeCompare(ordine(b)));

  let pubblicate = 0;
  // 3.0 (2026-10-25): notizie in silenzio dentro la newsletter della settimana, solo le importanti escono
  // subito. "Viste" per chat: il gruppo di prova non deve togliere notizie al gruppo vero
  if (v3(chatId)) {
    const visti = `${VISTI}:${chatId}`;
    for (const n of news) {
      if (await redis.sismember(visti, n.url)) continue;
      await salvaNews(n);
      const k = chiaveNews(n.url);
      await redis.sadd(kSettimana(chatId), k);
      if (importante(n)) {
        if (!n.img) n.img = await immagineArticolo(n.url);
        const testo = didascalia(n);
        const reply_markup = bottoneSubito(k);
        if (n.img) await tg("sendPhoto", { chat_id: chatId, photo: n.img, caption: testo, reply_markup }).catch(() => tg("sendMessage", { chat_id: chatId, text: testo, reply_markup }));
        else await tg("sendMessage", { chat_id: chatId, text: testo, reply_markup });
        pubblicate++;
      }
      await redis.sadd(visti, n.url);
    }
    return pubblicate;
  }
  for (const n of news) {
    if (await redis.sismember(VISTI, n.url)) continue;
    // La home ha la foto solo per le notizie in evidenza: per le altre la cerco nella pagina dell'articolo
    if (!n.img) n.img = await immagineArticolo(n.url);
    const testo = didascalia(n);
    // Bottone 📧 per scegliere la news per la newsletter del venerdì (lib/newsletter.ts)
    await salvaNews(n);
    const reply_markup = bottoneNews(chiaveNews(n.url), false);
    // Se Telegram non riesce a scaricare l'immagine, ripiega sul solo testo
    const msg = n.img
      ? await tg<{ message_id: number }>("sendPhoto", { chat_id: chatId, photo: n.img, caption: testo, reply_markup }).catch(() =>
          tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: testo, reply_markup }),
        )
      : await tg<{ message_id: number }>("sendMessage", { chat_id: chatId, text: testo, reply_markup });
    await salvaBottone(chiaveNews(n.url), chatId, msg.message_id);
    // Segnata come vista solo dopo l'invio: se l'invio fallisce, ci riprova al giro dopo invece di perderla
    await redis.sadd(VISTI, n.url);
    pubblicate++;
  }
  return pubblicate;
}

// Immagine di un articolo: og:image se c'è, altrimenti la prima immagine del testo (/media/content o /media/ckeditor,
// mai /media/banner che sono pubblicità del sito). Nessuna immagine o sito lento = undefined, la news esce solo testo.
export async function immagineArticolo(url: string): Promise<string | undefined> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return undefined;
    const html = await r.text();
    const og = html.match(/<meta property="og:image"\s+content="([^"]+)"/)?.[1];
    const src = og || html.match(/src="(\/media\/(?:content|ckeditor)\/[^"]+\.(?:jpe?g|png|webp))"/i)?.[1];
    return src ? new URL(src, url).href : undefined;
  } catch {
    return undefined;
  }
}

