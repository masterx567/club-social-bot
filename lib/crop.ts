import sharp from "sharp";
import { boxPersone, fasciaPersone } from "./soggetti";

// Foto aggiunte ai caroselli manuali: 4:5 come la copertina (Instagram vuole slide della stessa forma),
// ritaglio sulle persone. Ritorna anche un avviso se qualcuno resta fuori (decisione 2026-10-08).
const SW = 1080;
const SH = 1350;
// Taglio piccolo = niente riconoscimento persone (2026-10-13, velocità). Una foto verticale da telefono (3:4) per
// diventare 4:5 perde solo il 6% in altezza: non c'è niente da sbagliare, e saltare Groq evita le attese degli album
// (Groq gratuito accetta poche foto al minuto). Le foto orizzontali (taglio del 20-40% ai lati) lo usano sempre.
const TAGLIO_PICCOLO = 0.1;
export async function ritaglia45(input: Buffer): Promise<{ img: Buffer; avviso?: string }> {
  const { data, info } = await sharp(input).rotate().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const tolto = h / w > SH / SW ? 1 - (w * SH) / SW / h : 1 - (h * SW) / SH / w;
  const piccolo = tolto <= TAGLIO_PICCOLO;
  const b = piccolo ? null : await boxPersone(data);
  let left = 0,
    top = 0,
    cw = w,
    ch = h,
    avviso: string | undefined;

  if (h / w > SH / SW) {
    // Più alta del 4:5: si taglia in altezza, teste con un po' di margine sopra
    ch = Math.round((w * SH) / SW);
    if (b) {
      const fascia = (b.bottom - b.top) * h;
      top = fascia <= ch * 0.88 ? ((b.top + b.bottom) / 2) * h - ch / 2 : b.top * h - ch * 0.08;
      if (fascia > ch * 0.92) avviso = "qualcuno potrebbe restare tagliato in basso";
    } else top = (h - ch) * 0.2;
    top = Math.round(Math.min(h - ch, Math.max(0, top)));
  } else {
    // Più larga del 4:5: si taglia ai lati, centrata sulle persone
    cw = Math.round((h * SW) / SH);
    if (b) {
      left = ((b.left + b.right) / 2) * w - cw / 2;
      if ((b.right - b.left) * w > cw * 1.02) avviso = "foto larga: qualcuno resta fuori ai lati";
    } else {
      left = (w - cw) / 2;
      if (!piccolo) avviso = "persone non trovate, ritaglio al centro";
    }
    left = Math.round(Math.min(w - cw, Math.max(0, left)));
  }
  const img = await sharp(data).extract({ left, top, width: cw, height: ch }).resize(SW, SH).jpeg({ quality: 90 }).toBuffer();
  return { img, avviso };
}

// Area foto nel template Canva (elemento FOTO)
const W = 1122;
const H = 824;
// Senza Groq: foto più alta del riquadro, quanta parte dell'eccedenza togliere in alto (il resto in basso).
const TAGLIO_ALTO = 0.2;
// Parte alta del riquadro non coperta dall'onda (~700 su 824)
const VISIBILE = 700 / 824;
// Spazio sopra le teste: in alto c'è il logo, e Groq può sbagliare di qualche %.
// 4% e 10% tagliavano ancora le teste dei più alti in fondo (U14, 2026-10-05).
const SOPRA = 0.15;
const SOTTO = 0.04;
// Mai rimpicciolire o riempire con sfocato: foto intera su sfondo sfocato e strisce laterali
// sfocate sono state entrambe bocciate dall'admin (2026-10-05). Solo taglio.

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Riquadro FOTO del template evento: fascia orizzontale, niente onda sopra
// sposta: quota dell'eccedenza in altezza tolta sopra (0.5 = centrato). Evento 0.7 = foto "più su" nel riquadro
// (richiesta dell'admin 2026-10-09: con foto 4:3 centrate si tagliavano i piedi)
// volti (2026-10-24): foto evento verticale = taglio centrato sui volti, non sul corpo intero (Training for Future:
// muro sopra e facce tagliate sotto)
export const AREA_EVENTO = { W: 1122, H: 545, visibile: 1, volti: true }; // sposta 0.7 provato 2026-10-09: troppo, tornati a centrato

type Area = { W: number; H: number; visibile: number; sposta?: number; volti?: boolean };
export async function ritaglia(input: Buffer, area: Area = { W, H, visibile: VISIBILE }): Promise<Buffer> {
  return (await ritagliaConAvviso(input, area)).img;
}

// Come ritaglia(), più un avviso se qualcuno resta fuori dal riquadro (copertina risultato, 2026-10-18)
export async function ritagliaConAvviso(input: Buffer, area: Area = { W, H, visibile: VISIBILE }): Promise<{ img: Buffer; avviso?: string }> {
  const { W, H, visibile: VISIBILE } = area;
  const fatto = async (img: Promise<Buffer>, avviso?: string) => ({ img: await img, avviso });
  // rotate() applica l'orientamento EXIF delle foto da telefono
  const { data, info } = await sharp(input).rotate().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  if (area.sposta !== undefined && h / w > H / W && h <= w * 1.2) {
    // Foto orizzontale o quasi quadrata più alta del riquadro: taglio in altezza spostato in basso
    const altezza = Math.round((w * H) / W);
    const top = Math.round((h - altezza) * area.sposta);
    return fatto(sharp(data).extract({ left: 0, top, width: w, height: altezza }).resize(W, H).jpeg({ quality: 90 }).toBuffer());
  }

  if (h / w <= H / W) {
    // Foto orizzontale: taglio solo ai lati. "attention" di sharp si faceva attirare da fari/luci e tagliava i
    // giocatori ai bordi: si centra sulle persone trovate da Groq (Kolbe 2026-10-18: squadra a sinistra, centrato
    // al centro della foto si perdeva un ragazzo). Senza Groq, o taglio piccolo: centro della foto.
    const larghezza = Math.round((h * W) / H);
    const b = w - larghezza > w * TAGLIO_PICCOLO ? await boxPersone(data) : null;
    let left = (w - larghezza) / 2;
    let avviso: string | undefined;
    if (b) {
      left = ((b.left + b.right) / 2) * w - larghezza / 2;
      if ((b.right - b.left) * w > larghezza * 1.02) avviso = "foto larga: qualcuno resta fuori ai lati";
    }
    left = Math.round(clamp(left, 0, w - larghezza));
    return fatto(sharp(data).extract({ left, top: 0, width: larghezza, height: h }).resize(W, H).jpeg({ quality: 90 }).toBuffer(), avviso);
  }

  // Foto verticale: taglio solo in altezza, finestra larga quanto la foto.
  const altezza = Math.round((w * H) / W);
  const f = await fasciaPersone(data, area.volti);

  let top: number;
  if (area.volti) {
    // Volti un po' sopra il centro; se non ci stanno tutti vince la testa più alta. Senza Groq: poco sopra metà
    const alto = f ? f.top * h - altezza * 0.12 : 0;
    top = !f ? (h - altezza) * 0.4 : (f.bottom - f.top) * h <= altezza * 0.8 ? ((f.top + f.bottom) / 2) * h - altezza * 0.45 : alto;
  } else if (!f) {
    top = (h - altezza) * TAGLIO_ALTO;
  } else {
    // Groq sa dove stanno le persone (canestro, muro vuoto restano fuori).
    const su = f.top * h - SOPRA * altezza;
    const giu = f.bottom * h - (VISIBILE - SOTTO) * altezza;
    // Se il gruppo entra tra margine e onda lo centro, altrimenti vincono le teste
    top = giu <= su ? (su + giu) / 2 : su;
  }
  top = Math.round(clamp(top, 0, h - altezza));

  return fatto(sharp(data).extract({ left: 0, top, width: w, height: altezza }).resize(W, H).jpeg({ quality: 90 }).toBuffer());
}
