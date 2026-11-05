import { AREA_EVENTO, ritaglia, ritaglia45, ritagliaConAvviso } from "./crop";
import { archivia, autofillCampi, CanvaAuthError, caricaFoto, esportaImmagine } from "./canva";
import { avvisaAdmin, inviaFoto, scaricaFile, tg } from "./telegram";
import { proponiInstagram } from "./instagram";
import { testoAlternativo } from "./altTesto";
import { v3 } from "./prova";
import type { Ente } from "./store";

// /amichevole usa un template a parte (copia del risultato, titolo AMICHEVOLE arancione)
// 2026-10-20: copie con i loghi squadra LOGO_A / LOGO_B (131x160) ai lati del punteggio, al posto dei nomi.
// Prima: risultato DAxxxxxxxxx (variabile CANVA_TEMPLATE_DESIGN_ID), amichevole DAxxxxxxxxx
export type Tipo = "risultato" | "amichevole" | "torneo";
const TEMPLATE: Record<Tipo, string> = {
  // Sponsor Sponsor in alto a destra (2026-10-20, ok dell'admin). Senza Sponsor: risultato DAxxxxxxxxx, amichevole DAxxxxxxxxx
  // 2026-10-20: loghi squadra 160x195 e nome sempre sotto il logo. Prima: risultato DAxxxxxxxxx, amichevole DAxxxxxxxxx
  risultato: "DAxxxxxxxxx",
  amichevole: "DAxxxxxxxxx",
  // Torneo (l'admin 2026-11-01, 3.7.0): niente punteggio, si dice solo che abbiamo partecipato. Logo SS Cormano e
  // logo di chi organizza affiancati al centro, nomi sotto, campo RISULTATO tolto. Prima (3.6.0, come l'amichevole
  // con scritto TORNEO): DAxxxxxxxxx
  torneo: "DAxxxxxxxxx",
};
// 3.0 (2026-10-27): logo del campionato in alto a destra (LOGO_ENTE), Sponsor accanto al logo SS Cormano,
// via la decorazione d'angolo. Logo tenuto lontano dal contatore 1/x dei caroselli Instagram.
// Senza ente il campo resta vuoto. Asset Canva: riquadro bianco arrotondato, originali in docs/enti/.
const TEMPLATE_V3_RISULTATO = "DAxxxxxxxxx";
const LOGO_ENTE: Record<Ente, string> = { CSI: "MAHZMJSmagg", FIP: "MAHZMNHV1oE", UISP: "MAHZMLryXko" };

export interface Richiesta {
  tipo: Tipo;
  chatId: number;
  fileId: string;
  photoMsgId: number;
  statusMsgId: number; // "⏳ Creo la grafica…", cancellato alla fine
  categoria: string; // es. "UNDER 14 · BASKET"
  risultato: string; // es. "1 - 3"
  squadraA: string;
  squadraB: string;
  // Asset Canva dei loghi: con il logo il nome non si scrive, senza resta il nome
  logoA?: string;
  logoB?: string;
  ente?: Ente; // 3.0: campionato della partita, per il logo in grafica
}

export async function generaGrafica(r: Richiesta) {
  const t0 = Date.now();
  try {
    const tempi: string[] = [];
    const lap = (n: string) => tempi.push(`${n} ${Date.now() - t0}ms`);
    const { img: foto, avviso } = await ritagliaConAvviso(await scaricaFile(r.fileId));
    lap("foto");
    const data = new Date().toISOString().slice(0, 10);
    const assetId = await caricaFoto(foto, `bot ${data} ${r.categoria}`);
    lap("upload");
    const conEnte = v3(r.chatId) && r.tipo === "risultato";
    const torneo = r.tipo === "torneo";
    const loghi = { ...(r.logoA ? { LOGO_A: r.logoA } : {}), ...(r.logoB ? { LOGO_B: r.logoB } : {}), ...(conEnte && r.ente ? { LOGO_ENTE: LOGO_ENTE[r.ente] } : {}) };
    // Il nome resta sempre, sotto il logo (2026-10-20)
    const designId = await autofillCampi(
      conEnte ? TEMPLATE_V3_RISULTATO : TEMPLATE[r.tipo],
      torneo ? `Torneo ${r.categoria} ${r.squadraB} ${data}` : `${r.tipo === "amichevole" ? "Amichevole" : "Risultato"} ${r.categoria} ${r.risultato} ${data}`,
      // Il template del torneo non ha il campo RISULTATO
      { ...(torneo ? {} : { RISULTATO: r.risultato }), CATEGORIA: r.categoria, SQUADRA_A: r.squadraA, SQUADRA_B: r.squadraB },
      { FOTO: assetId, ...loghi },
    );
    lap("autofill");
    const png = await esportaImmagine(designId);
    lap("export");
    // Torneo: la prima riga dice chi organizza (la legge la bozza, lib/bozza.ts), la seconda è la categoria come sempre
    const didascalia = torneo ? `TORNEO ORGANIZZATO DA ${r.squadraB}\n${r.categoria}` : `${r.squadraA} ${r.risultato} ${r.squadraB}
${r.categoria}`;
    const copertina = await inviaFoto(r.chatId, png, didascalia, r.photoMsgId);
    // 3.0: l'avviso sulla foto sta in cima alla scheda del post, non in un messaggio a parte (si perdeva)
    if (avviso && !v3(r.chatId))
      await tg("sendMessage", {
        chat_id: r.chatId,
        text: `⚠️ ${avviso[0].toUpperCase()}${avviso.slice(1)}.\nSe serve, rimanda una foto meno larga.`,
        reply_parameters: { message_id: copertina, allow_sending_without_reply: true },
      }).catch(() => {});
    // Post manuale: la didascalia la scrive una persona, il testo automatico fa solo da spunto (2026-10-10)
    await proponiInstagram(r.chatId, [png], didascalia, { copertina, didascaliaUmana: true, tipo: r.tipo, categoria: r.categoria, ente: r.tipo === "risultato" ? r.ente : undefined, alt: testoAlternativo(r), avvisi: avviso ? [`foto: ${avviso}`] : [] }).catch((e) => avvisaAdmin(`⚠️ Bottone Instagram non proposto: ${(e as Error).message}`));

    // Pulizia: non blocca l'utente se fallisce
    await archivia(designId, assetId).catch((e) => avvisaAdmin(`⚠️ Pulizia Canva fallita (grafica inviata comunque):\n${e}`));
    lap("invio");
    console.log(`ok ${r.categoria} ${r.risultato} | ${tempi.join(" · ")}`);
  } catch (e) {
    console.error(e);
    await tg("sendMessage", {
      chat_id: r.chatId,
      text: "⚠️ Errore nella creazione della grafica, riprova tra poco.",
      reply_parameters: { message_id: r.photoMsgId, allow_sending_without_reply: true },
    }).catch(() => {});
    if (e instanceof CanvaAuthError) {
      const link = `${process.env.BASE_URL}/api/canva-auth?key=${process.env.SETUP_SECRET}`;
      await avvisaAdmin(`🔑 Serve rifare il login Canva. Apri:\n${link}\n\nDettaglio: ${e.message}`);
    } else {
      await avvisaAdmin(`❌ Bot risultati, errore:\n${e instanceof Error ? e.stack || e.message : e}`);
    }
  } finally {
    await tg("deleteMessage", { chat_id: r.chatId, message_id: r.statusMsgId }).catch(() => {});
  }
}

// 3.0 📷 Post foto (2026-10-25): niente grafica, la foto ritagliata 4:5 è la copertina. Stessa scheda dei
// post manuali: altre foto in risposta alla copertina, testo del post dalla bozza o da chi risponde alla scheda.
export async function generaPostFoto(r: { chatId: number; fileId: string; photoMsgId: number; statusMsgId: number }) {
  try {
    const { img, avviso } = await ritagliaConAvviso(await scaricaFile(r.fileId));
    const copertina = await inviaFoto(r.chatId, img, "📷 Post foto", r.photoMsgId);
    await proponiInstagram(r.chatId, [img], "Post di foto", { copertina, didascaliaUmana: true, evento: true, tipo: "post foto", avvisi: avviso ? [`foto: ${avviso}`] : [] });
  } catch (e) {
    console.error(e);
    await tg("sendMessage", { chat_id: r.chatId, text: "⚠️ Errore nella preparazione del post, riprova tra poco." }).catch(() => {});
    await avvisaAdmin(`❌ Post foto, errore:\n${e instanceof Error ? e.stack || e.message : e}`);
  } finally {
    await tg("deleteMessage", { chat_id: r.chatId, message_id: r.statusMsgId }).catch(() => {});
  }
}

// /evento: foto + titolo sul template eventi (DAxxxxxxxxx, campi FOTO / TITOLO)
const TEMPLATE_EVENTO = process.env.CANVA_TEMPLATE_EVENTO_ID || "DAxxxxxxxxx";

// Campi del template: titolo giallo sotto la cornice (SOPRATITOLO, es. WINNERS CUP) e sottotitolo bianco (TITOLO,
// il nome del campo è rimasto quello di prima). l'admin 2026-10-11.
export async function generaEvento(r: { chatId: number; fileId: string; photoMsgId: number; statusMsgId: number; titolo: string; sottotitolo: string }) {
  try {
    const foto = await ritaglia(await scaricaFile(r.fileId), AREA_EVENTO);
    const data = new Date().toISOString().slice(0, 10);
    const assetId = await caricaFoto(foto, `bot ${data} evento`);
    const t = titoloEvento(r.sottotitolo);
    const nome = [r.titolo, r.sottotitolo].filter(Boolean).join(" ");
    // Canva non accetta testo vuoto: senza titolo giallo uno spazio
    const designId = await autofillCampi(t.template, `Evento ${nome} ${data}`, { SOPRATITOLO: r.titolo || " ", TITOLO: t.testo }, { FOTO: assetId });
    const png = await esportaImmagine(designId);
    const didascalia = [r.titolo, r.sottotitolo].filter(Boolean).join("\n");
    const copertina = await inviaFoto(r.chatId, png, didascalia, r.photoMsgId);
    // La didascalia del post evento la scrive una persona (2026-10-09): stesso meccanismo dei post manuali
    // (2026-10-10), il ✅ non pubblica finché manca. Foto aggiunte in risposta alla grafica, come per le copertine.
    await proponiInstagram(r.chatId, [png], didascalia, { copertina, didascaliaUmana: true, evento: true }).catch((e) => avvisaAdmin(`⚠️ Bottone Instagram non proposto: ${(e as Error).message}`));
    await archivia(designId, assetId).catch((e) => avvisaAdmin(`⚠️ Pulizia Canva fallita (grafica inviata comunque):
${e}`));
  } catch (e) {
    console.error(e);
    await tg("sendMessage", {
      chat_id: r.chatId,
      text: "⚠️ Errore nella creazione della grafica, riprova tra poco.",
      reply_parameters: { message_id: r.photoMsgId, allow_sending_without_reply: true },
    }).catch(() => {});
    if (e instanceof CanvaAuthError) {
      const link = `${process.env.BASE_URL}/api/canva-auth?key=${process.env.SETUP_SECRET}`;
      await avvisaAdmin(`🔑 Serve rifare il login Canva. Apri:
${link}

Dettaglio: ${e.message}`);
    } else {
      await avvisaAdmin(`❌ Bot /evento, errore:
${e instanceof Error ? e.stack || e.message : e}`);
    }
  } finally {
    await tg("deleteMessage", { chat_id: r.chatId, message_id: r.statusMsgId }).catch(() => {});
  }
}

// /evento con "🖼 Uso questa foto" (2026-10-24): la foto è già la copertina, solo portata al 4:5.
// Poi come l'evento: foto in risposta, didascalia scritta da una persona.
export async function copertinaPropria(r: { chatId: number; fileId: string; photoMsgId: number; statusMsgId: number }) {
  try {
    const { img } = await ritaglia45(await scaricaFile(r.fileId));
    const copertina = await inviaFoto(r.chatId, img, "Evento", r.photoMsgId);
    await proponiInstagram(r.chatId, [img], "Evento", { copertina, didascaliaUmana: true, evento: true });
  } catch (e) {
    console.error(e);
    await tg("sendMessage", { chat_id: r.chatId, text: "⚠️ Errore nella copertina, riprova tra poco." }).catch(() => {});
    await avvisaAdmin(`❌ Bot /evento copertina propria, errore:
${e instanceof Error ? e.stack || e.message : e}`);
  } finally {
    await tg("deleteMessage", { chat_id: r.chatId, message_id: r.statusMsgId }).catch(() => {});
  }
}

// Titolo evento sempre dentro lo spazio sotto la barra gialla (l'admin 2026-10-11: "SS CORMANO & PANZEROTTI: UN
// GEMELLAGGIO SPECIALE!" andava a capo più volte e saliva sulla foto). Canva non rimpicciolisce il testo da solo:
// un template per dimensione del titolo (copie di DAxxxxxxxxx, testo centrato sotto la barra) e si sceglie la più
// grande in cui ogni riga sta in larghezza. car = caratteri massimi per riga, righe = righe che stanno in altezza.
// Prima scelta sempre due righe (regola del 2026-10-09); più righe solo se due non bastano neanche al più piccolo.
// 2026-10-11: sopra c'è il titolo giallo, il sottotitolo bianco ha meno spazio (zona 935..1270, centrato a 1100)
// 2026-10-16 sottotitolo un po' più grande (l'admin): +8% sul più grande, +5/7% sugli altri, caratteri per riga ridotti in proporzione
const TITOLI_EVENTO = [
  { px: 121, template: TEMPLATE_EVENTO, car: 17, righe: 2 },
  { px: 97, template: "DAxxxxxxxxx", car: 21, righe: 3 },
  { px: 81, template: "DAxxxxxxxxx", car: 26, righe: 3 },
  { px: 66, template: "DAxxxxxxxxx", car: 32, righe: 4 },
  { px: 55, template: "DAxxxxxxxxx", car: 39, righe: 5 },
];

// Lunghezza "visiva": le emoji sono larghe circa due lettere
const lung = (s: string) => [...s].reduce((n, c) => n + (/\p{Extended_Pictographic}/u.test(c) ? 2 : 1), 0);

// Parole divise in k righe con la riga più lunga più corta possibile (a capo solo tra le parole)
export function inRighe(t: string, k: number): string[] {
  const p = t.trim().split(/\s+/);
  if (k <= 1 || p.length <= 1) return [p.join(" ")];
  if (k >= p.length) return p;
  let meglio: string[] = [], max = Infinity;
  const prova = (i: number, resto: number, fatte: string[]) => {
    if (resto === 1) {
      const tutte = [...fatte, p.slice(i).join(" ")];
      const m = Math.max(...tutte.map(lung));
      if (m < max) [max, meglio] = [m, tutte];
      return;
    }
    for (let j = i + 1; j <= p.length - resto + 1; j++) {
      const riga = p.slice(i, j).join(" ");
      if (lung(riga) >= max) break;
      prova(j, resto - 1, [...fatte, riga]);
    }
  };
  prova(0, k, []);
  return meglio;
}

export function titoloEvento(titolo: string): { testo: string; template: string; px: number } {
  for (let k = 2; k <= 6; k++) {
    const righe = inRighe(titolo, k);
    const m = Math.max(...righe.map(lung));
    const d = TITOLI_EVENTO.find((x) => righe.length <= x.righe && m <= x.car);
    if (d) return { testo: righe.join("\n"), template: d.template, px: d.px };
  }
  // Titolo lunghissimo: il più piccolo, a capo dove serve (Canva va a capo da solo nelle righe troppo lunghe)
  const ultimo = TITOLI_EVENTO[TITOLI_EVENTO.length - 1];
  return { testo: inRighe(titolo, 6).join("\n"), template: ultimo.template, px: ultimo.px };
}

// Titolo sempre su due righe (scelta dell'admin 2026-10-09): a capo allo spazio più vicino a metà
export function dueRighe(t: string): string {
  const p = t.trim().split(/\s+/);
  if (p.length < 2) return t.trim();
  let best = 1, diff = Infinity;
  for (let i = 1; i < p.length; i++) {
    const d = Math.abs(p.slice(0, i).join(" ").length - p.slice(i).join(" ").length);
    if (d < diff) [best, diff] = [i, d];
  }
  return `${p.slice(0, best).join(" ")}
${p.slice(best).join(" ")}`;
}
