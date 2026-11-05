import { proponiCampionati } from "./campionati";
import sharp from "sharp";
import { CanvaAuthError, autofillCampi, caricaFoto, esportaImmagine, spostaInCartella } from "./canva";
import { aggiornaPartite, etichettaDate, isoOggi } from "./carosello";
import { Partita, categoriaDi, nomeBreve, partiteTra } from "./partite";
import { redis } from "./store";
import { chiedi, Domanda } from "./domande";
import { avvisaAdmin, inviaAlbum, tg } from "./telegram";
import { proponiInstagram } from "./instagram";
import { chiediAccount } from "./account";

// "Partite della settimana": stesso schema del carosello risultati, ma guarda avanti.
// SS CORMANO sempre a sinistra (fissa nel template), a destra avversario + logo, nel box categoria e "SAB 15:00".
// Etichette uguali in tutti i template: DATA, R{n}_AVV / R{n}_LOGO / R{n}_CAT / R{n}_ORA
// 2026-10-19: copie con il logo SSC giallo in alto a sinistra. Ritorno: DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx,
// DAxxxxxxxxx, DAxxxxxxxxx
// 2026-10-20: copie con Sponsor in alto a destra. Ritorno senza Sponsor: DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx
// 2026-10-22: Sponsor spostato accanto al logo SSC a sinistra. Ritorno con Sponsor a destra: DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx
// 2026-10-22 (bis): stessi template modificati in Canva, loghi SSC 105x90 e Sponsor 143x90 (prima 84x72 e 114x72)
const TEMPLATE: Record<number, string> = {
  5: "DAxxxxxxxxx",
  4: "DAxxxxxxxxx",
  3: "DAxxxxxxxxx",
  2: "DAxxxxxxxxx",
  1: "DAxxxxxxxxx",
};
const PER_SLIDE = 5;

const GIORNI = ["DOM", "LUN", "MAR", "MER", "GIO", "VEN", "SAB"];
const giorno = (iso: string) => GIORNI[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const MESI3 = ["GEN", "FEB", "MAR", "APR", "MAG", "GIU", "LUG", "AGO", "SET", "OTT", "NOV", "DIC"];
// Due righe nel box orario: "SAB 10 OTT" sopra, "16:00" sotto. Chi guarda il post deve sapere il giorno esatto di ogni gara
const quando = (p: Partita) =>
  `${giorno(p.data)} ${Number(p.data.slice(8, 10))} ${MESI3[Number(p.data.slice(5, 7)) - 1]}${p.ora ? `
${p.ora}` : ""}`;

// Il box categoria è largo ~16 caratteri: "UNDER 14 · BASKET" non ci sta, "U14 BASKET" sì
export const catBreve = (etichetta: string) =>
  etichetta
    .replace(/UNDER\s*/g, "U")
    .replace("OPEN ECCELLENZA", "OPEN ECC.")
    .replace(" FEMM.", " F")
    .replace(" · ", " ");

// ---- Loghi avversari: Redis "loghi", nome corto (quello in grafica) -> asset Canva ----

export const getLogo = (nome: string) => redis.hget<string>("loghi", nome.toUpperCase());

// Logo SSC giallo nelle proporzioni dei loghi squadra (348x424), lo stesso dei risultati della settimana
export const LOGO_LV = "MAHYdM2v9n8";
// Logo di una squadra per la grafica: SS Cormano il suo, gli altri da Redis o dal portale
export async function logoSquadra(nome: string, url?: string): Promise<string | null> {
  if (nome === "SS CORMANO") return LOGO_LV;
  return (await getLogo(nome)) || (await logoDalPortale(nome, url));
}

// Il box logo nel template è 87x106: il logo va centrato su fondo trasparente con le stesse proporzioni,
// altrimenti Canva lo ritaglia per riempire il box
// I loghi del CSI (e molte foto mandate in chat) sono JPEG su fondo bianco: sulla riga verde farebbero un quadrato.
// Rendo trasparente il bianco collegato ai bordi; il bianco dentro al logo, chiuso dal contorno, resta.
export async function togliFondoBianco(img: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const bianco = (i: number) => data[i * 4] > 235 && data[i * 4 + 1] > 235 && data[i * 4 + 2] > 235 && data[i * 4 + 3] > 0;
  const visto = new Uint8Array(w * h);
  const coda: number[] = [];
  for (let x = 0; x < w; x++) coda.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) coda.push(y * w, y * w + w - 1);
  while (coda.length) {
    const i = coda.pop()!;
    if (visto[i] || !bianco(i)) continue;
    visto[i] = 1;
    data[i * 4 + 3] = 0;
    const x = i % w;
    if (x > 0) coda.push(i - 1);
    if (x < w - 1) coda.push(i + 1);
    if (i >= w) coda.push(i - w);
    if (i < w * (h - 1)) coda.push(i + w);
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// Logo dal portale (CSI pubblica quello di ogni società): scaricato e salvato una volta, poi resta in Redis
export async function logoDalPortale(nome: string, url?: string): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    await salvaLogo(nome, Buffer.from(await r.arrayBuffer()));
    return getLogo(nome);
  } catch (e) {
    console.error(`logo ${nome} da ${url}:`, e);
    return null;
  }
}

export async function salvaLogo(nome: string, img: Buffer): Promise<void> {
  const png = await sharp(await togliFondoBianco(img))
    .resize(348, 424, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const assetId = await caricaFoto(png, `logo ${nome}`);
  await redis.hset("loghi", { [nome.toUpperCase()]: assetId });
}

interface Riga {
  avv: string;
  logo: string | null;
  cat: string;
  ora: string;
  data: string;
}

export async function preparaSettimana(da: string, a: string) {
  const ps = (await partiteTra(da, a))
    .filter((p) => p.stato !== "giocata")
    .sort((x, y) => x.data.localeCompare(y.data) || x.ora.localeCompare(y.ora));
  const righe: Riga[] = [];
  const rinviate: Partita[] = [];
  const senzaNome = new Set<string>();
  const urlLogo: Record<string, string> = {}; // nome lungo -> logo sul portale, per controllarlo dopo il nome corto
  const senzaCategoria = new Set<string>();
  const senzaLogo = new Set<string>();
  const senzaOra: Partita[] = [];

  for (const p of ps) {
    if (p.stato === "rinviata") {
      rinviate.push(p);
      continue;
    }
    const cat = categoriaDi(p);
    if (!cat) {
      senzaCategoria.add(`${p.ente}:${p.campionato}|${p.campionatoNome}`);
      continue;
    }
    const lvInCasa = /linea\s*verde/i.test(p.casa);
    const portale = lvInCasa ? p.ospite : p.casa;
    const avv = await nomeBreve(portale);
    if (!avv) {
      senzaNome.add(portale);
      const url = lvInCasa ? p.logoOspite : p.logoCasa;
      if (url) urlLogo[portale] = url;
      continue;
    }
    const logo = (await getLogo(avv)) || (await logoDalPortale(avv, lvInCasa ? p.logoOspite : p.logoCasa));
    if (!logo) senzaLogo.add(avv);
    if (!p.ora) senzaOra.push(p);
    righe.push({ avv, logo, cat: catBreve(cat.etichetta), ora: quando(p), data: p.data });
  }
  return { righe, rinviate, senzaNome: [...senzaNome], urlLogo, senzaCategoria: [...senzaCategoria], senzaLogo: [...senzaLogo], senzaOra };
}

const ggmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const partitaTxt = (p: Partita) => `${p.casa} - ${p.ospite} (${ggmm(p.data)})`;

// giorni = quanti giorni guardare avanti a partire da domani (default 7: da giovedì a mercoledì)
// richiedente: chi ha lanciato /settimana (riceve in privato le richieste dei loghi); dal cron non c'è
export async function generaSettimana(chatId: number, giorni = 7, statusMsgId?: number, richiedente?: number, faiDomande = true) {
  try {
    const agg = await aggiornaPartite();
    if (agg.errori.length) await avvisaAdmin(`⚠️ Aggiornamento partite:\n${agg.errori.join("\n")}`);

    const da = isoOggi(new Date(Date.now() + 86_400_000));
    const a = isoOggi(new Date(Date.now() + giorni * 86_400_000));
    const prep = await preparaSettimana(da, a);

    // Loghi e nomi mancanti: domande una alla volta, a coda finita il carosello si rifà da solo.
    // Nel giro rifatto (faiDomande = false) quelli saltati restano fuori senza richiedere
    const domande: Domanda[] = [
      ...prep.senzaNome.map((nome): Domanda => ({ tipo: "alias", nome, logoUrl: prep.urlLogo[nome] })),
      ...prep.senzaLogo.map((nome): Domanda => ({ tipo: "logo", nome })),
    ];
    const note: string[] = [];
    if (prep.senzaNome.length && !faiDomande) note.push(`✏️ Fuori per nome troppo lungo:\n${prep.senzaNome.join("\n")}`);
    if (prep.senzaOra.length) note.push(`🕒 Orario non ancora sul portale:\n${prep.senzaOra.map(partitaTxt).join("\n")}`);
    if (prep.rinviate.length) note.push(`↪️ Rinviate:\n${prep.rinviate.map(partitaTxt).join("\n")}`);
    if (prep.senzaCategoria.length) await proponiCampionati(prep.senzaCategoria, chatId, "settimana", giorni);
    // Domande subito, prima delle grafiche: in fondo si perdevano se la funzione finiva il tempo (Giravolta, 2026-10-21)
    if (faiDomande) await chiedi(chatId, domande, "settimana", giorni, richiedente);
    // Account Instagram delle avversarie per i tag (Issue 10): domanda a parte, la grafica non cambia
    await chiediAccount(prep.righe.map((r) => r.avv)).catch((e) => console.error("chiediAccount", e));

    if (!prep.righe.length) {
      await tg("sendMessage", { chat_id: chatId, text: [`Nessuna partita tra ${ggmm(da)} e ${ggmm(a)}.`, ...note].join("\n\n") });
      return;
    }

    const date = prep.righe.map((r) => r.data).sort();
    const etichetta = etichettaDate(date[0], date[date.length - 1]);
    const immagini: Buffer[] = [];
    const design: string[] = [];
    const slide: Riga[][] = [];
    for (let i = 0; i < prep.righe.length; i += PER_SLIDE) slide.push(prep.righe.slice(i, i + PER_SLIDE));

    for (const [i, s] of slide.entries()) {
      const testi: Record<string, string> = { DATA: etichetta };
      const immaginiCampi: Record<string, string> = {};
      s.forEach((r, j) => {
        const n = j + 1;
        Object.assign(testi, { [`R${n}_AVV`]: r.avv, [`R${n}_CAT`]: r.cat, [`R${n}_ORA`]: r.ora });
        // Senza logo il campo non si passa: resta lo scudetto grigio del template
        if (r.logo) immaginiCampi[`R${n}_LOGO`] = r.logo;
      });
      const id = await autofillCampi(TEMPLATE[s.length], `Partite ${etichetta} ${date[0].slice(0, 4)} (${i + 1}/${slide.length})`, testi, immaginiCampi);
      design.push(id);
      immagini.push(await esportaImmagine(id));
    }

    await inviaAlbum(chatId, immagini, `Partite della settimana ${etichetta}`);
    // Controllo dati: ogni dubbio sui portali toglie la pubblicazione automatica
    const avvisi = [
      ...agg.errori.map((e) => `portale non letto, ${e}`),
      ...(prep.senzaCategoria.length ? [`${prep.senzaCategoria.length} campionati sconosciuti: partite escluse`] : []),
      ...(prep.senzaOra.length ? [`${prep.senzaOra.length} partite senza orario`] : []),
      ...(faiDomande && domande.length ? [`mancano ${domande.length} tra loghi e nomi: dopo le risposte arriva la versione completa`] : []),
    ];
    await proponiInstagram(chatId, immagini, `Partite della settimana ${etichetta}`, { auto: true, flusso: "settimana", avvisi, rifatto: !faiDomande, avversari: slide.map((s) => s.map((r) => r.avv)) }).catch((e) => avvisaAdmin(`⚠️ Bottone Instagram non proposto: ${(e as Error).message}`));
    if (note.length) await tg("sendMessage", { chat_id: chatId, text: note.join("\n\n") });
    for (const id of design) await spostaInCartella(id).catch(() => {});
  } catch (e) {
    console.error(e);
    await tg("sendMessage", { chat_id: chatId, text: "⚠️ Errore nella creazione delle partite della settimana, riprova tra poco." }).catch(() => {});
    if (e instanceof CanvaAuthError) {
      const link = `${process.env.BASE_URL}/api/canva-auth?key=${process.env.SETUP_SECRET}`;
      await avvisaAdmin(`🔑 Serve rifare il login Canva. Apri:\n${link}\n\nDettaglio: ${e.message}`);
    } else {
      await avvisaAdmin(`❌ Partite settimana, errore:\n${e instanceof Error ? e.stack || e.message : e}`);
    }
  } finally {
    if (statusMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  }
}
