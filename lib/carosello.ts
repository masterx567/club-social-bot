import { proponiCampionati } from "./campionati";
import { CanvaAuthError, autofillCampi, esportaImmagine, spostaInCartella } from "./canva";
import { getLogo, logoDalPortale } from "./settimana";
import { partiteCsi } from "./fonti/csi";
import { partiteFip } from "./fonti/fip";
import { partiteUisp } from "./fonti/uisp";
import { Partita, categoriaDi, nomeBreve, ordine, partiteTra, salvaPartite, togliSparite } from "./partite";
import { avvisaAdmin, inviaAlbum, tg } from "./telegram";
import { chiedi, Domanda, kRisultatoManuale } from "./domande";
import { redis } from "./store";
import { proponiInstagram } from "./instagram";
import { v3 } from "./prova";

// Template per numero di righe: le pagine piene usano R5, l'ultima la variante con le righe giuste.
// Le etichette sono uguali in tutti: DATA, R{n}_CAT / R{n}_CASA / R{n}_PC / R{n}_PO / R{n}_OSP
// e i loghi R{n}_LCASA / R{n}_LOSP (2026-10-19, copie dei template di prima: DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx,
// DAxxxxxxxxx, DAxxxxxxxxx restano come ritorno). Senza logo il campo non si passa: resta il riquadro trasparente.
// 2026-10-20: copie con Sponsor accanto al logo SSC, coppia centrata. Ritorno senza Sponsor: DAxxxxxxxxx, DAxxxxxxxxx,
// DAxxxxxxxxx, DAxxxxxxxxx, DAxxxxxxxxx
const TEMPLATE: Record<number, string> = {
  5: "DAxxxxxxxxx",
  4: "DAxxxxxxxxx",
  3: "DAxxxxxxxxx",
  2: "DAxxxxxxxxx",
  1: "DAxxxxxxxxx",
};
// Logo SSC giallo nelle proporzioni dei loghi squadra (348x424), asset Canva
const LOGO_LV = "MAHYdM2v9n8";
const PER_SLIDE = 5;

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

// Data di oggi a Milano in formato "2026-10-01" (Vercel gira in UTC)
export const isoOggi = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

// "24 settembre", "27-28 settembre", "30 set - 1 ott": deve stare su una riga nella barra gialla
export function etichettaDate(da: string, a: string): string {
  const g = (s: string) => Number(s.slice(8, 10));
  const m = (s: string) => MESI[Number(s.slice(5, 7)) - 1];
  if (da === a) return `${g(da)} ${m(da)}`;
  if (da.slice(0, 7) === a.slice(0, 7)) return `${g(da)}-${g(a)} ${m(a)}`;
  return `${g(da)} ${m(da).slice(0, 3)} - ${g(a)} ${m(a).slice(0, 3)}`;
}

const ggmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// "01 Ottobre": data di esecuzione nella barra gialla
const giornoMese = (iso: string) => {
  const m = MESI[Number(iso.slice(5, 7)) - 1];
  return `${iso.slice(8, 10)} ${m[0].toUpperCase()}${m.slice(1)}`;
};
const partitaTxt = (p: Partita) => `${p.casa} - ${p.ospite}${p.data ? ` (${ggmm(p.data)})` : ""}`;

// Scarica le fonti e aggiorna l'archivio. Una fonte che fallisce non ferma le altre.
export async function aggiornaPartite(): Promise<{ trovate: number; perFonte: Record<string, number>; errori: string[] }> {
  const fonti: [string, () => Promise<Partita[]>][] = [
    ["CSI", partiteCsi],
    ["FIP", partiteFip],
    ["UISP", partiteUisp],
  ];
  let trovate = 0;
  const perFonte: Record<string, number> = {};
  const errori: string[] = [];
  for (const [nome, scarica] of fonti) {
    try {
      const ps = await scarica();
      // Zero partite in una stagione in corso = portale cambiato o scraper rotto, non "nessuna partita".
      // UISP esclusa finché il comitato di Milano non pubblica i calendari (nessuna fase = 0 gare, ed è normale)
      if (!ps.length && nome !== "UISP") errori.push(`${nome}: 0 partite trovate, probabile rottura dello scraper`);
      await salvaPartite(ps);
      // CSI e UISP leggono tutta la stagione: una gara salvata che non c'è più è stata tolta dal portale (l'admin
      // 2026-11-03: UISP ha rifatto il calendario U16 F come U16-17 F e le gare vecchie restavano, senza risultato).
      // FIP no: legge solo una finestra di giorni. Con 0 gare (portale rotto) non si toglie niente
      if (ps.length && nome !== "FIP") await togliSparite(nome, ps);
      trovate += ps.length;
      perFonte[nome] = ps.length;
    } catch (e) {
      errori.push(`${nome}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { trovate, perFonte, errori };
}

// Partita di oggi: il risultato si chiede solo 2 ore dopo l'orario d'inizio (l'admin 2026-11-03: a mezzogiorno
// il bot chiedeva il punteggio di una gara delle 21). Senza orario si aspetta domani
function finita(p: Partita, oggi: string) {
  if (p.data < oggi) return true;
  if (p.data > oggi || !/^\d{2}:\d{2}$/.test(p.ora || "")) return false;
  const ora = new Date().toLocaleTimeString("sv-SE", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
  const [h, m] = p.ora.split(":").map(Number);
  return ora >= `${String(h + 2).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

interface Riga {
  cat: string;
  casa: string;
  ospite: string;
  logoCasa: string | null;
  logoOspite: string | null;
  pc: number;
  po: number;
  data: string;
}

export async function preparaCarosello(da: string, a: string) {
  const oggi = isoOggi();
  const ps = (await partiteTra(da, a)).sort((x, y) => ordine(x) - ordine(y) || x.data.localeCompare(y.data));
  const righe: Riga[] = [];
  const mancanti: Partita[] = []; // data passata ma ancora senza risultato sul portale
  const rinviate: Partita[] = [];
  const senzaNome = new Set<string>(); // nomi > 13 caratteri senza alias
  const urlLogo: Record<string, string> = {}; // nome lungo -> logo sul portale, per controllarlo dopo il nome corto
  const senzaCategoria = new Set<string>(); // campionati da aggiungere in partite.ts
  const senzaLogo = new Set<string>(); // squadre senza logo: si chiede in chat come per la settimana
  const logo = async (nome: string, url?: string) => {
    if (nome === "SS CORMANO") return LOGO_LV;
    const id = (await getLogo(nome)) || (await logoDalPortale(nome, url));
    if (!id) senzaLogo.add(nome);
    return id;
  };

  for (let p of ps) {
    if (p.stato === "rinviata") {
      rinviate.push(p);
      continue;
    }
    if (p.stato === "da_giocare") {
      // Senza punteggio sul portale: vale quello dato in chat, se c'è (2026-10-20)
      const man = p.data && p.data <= oggi ? await redis.get<{ pc: number; po: number }>(kRisultatoManuale(p.id)) : null;
      if (!man) {
        if (finita(p, oggi)) mancanti.push(p);
        continue;
      }
      p = { ...p, pc: man.pc, po: man.po, stato: "giocata" };
    }
    const cat = categoriaDi(p);
    if (!cat) {
      senzaCategoria.add(`${p.ente}:${p.campionato}|${p.campionatoNome}`);
      continue;
    }
    const [casa, ospite] = [await nomeBreve(p.casa), await nomeBreve(p.ospite)];
    if (!casa) senzaNome.add(p.casa);
    if (!ospite) senzaNome.add(p.ospite);
    if (!casa && p.logoCasa) urlLogo[p.casa] = p.logoCasa;
    if (!ospite && p.logoOspite) urlLogo[p.ospite] = p.logoOspite;
    if (!casa || !ospite) continue;
    const [logoCasa, logoOspite] = [await logo(casa, p.logoCasa), await logo(ospite, p.logoOspite)];
    righe.push({ cat: cat.etichetta, casa, ospite, logoCasa, logoOspite, pc: p.pc!, po: p.po!, data: p.data });
  }
  return { righe, mancanti, rinviate, senzaNome: [...senzaNome], urlLogo, senzaCategoria: [...senzaCategoria], senzaLogo: [...senzaLogo] };
}

// richiedente: chi ha lanciato /carosello (riceve le domande in privato); faiDomande = false nel giro rifatto dopo le risposte
export async function generaCarosello(chatId: number, giorni: number, statusMsgId?: number, richiedente?: number, faiDomande = true) {
  try {
    const agg = await aggiornaPartite();
    if (agg.errori.length) await avvisaAdmin(`⚠️ Aggiornamento partite:\n${agg.errori.join("\n")}`);

    const a = isoOggi();
    const da = isoOggi(new Date(Date.now() - giorni * 86_400_000));
    const prep = await preparaCarosello(da, a);

    const note: string[] = [];
    // 3.0: le domande arrivano nell'argomento del post, non in privato
    const dove = v3(chatId) ? "qui" : "in privato";
    if (prep.mancanti.length) note.push(`⏳ Senza risultato sul portale${faiDomande ? `, lo chiedo ${dove}` : ""}:\n${prep.mancanti.map(partitaTxt).join("\n")}`);
    if (prep.rinviate.length) note.push(`↪️ Rinviate:\n${prep.rinviate.map(partitaTxt).join("\n")}`);
    if (prep.senzaNome.length && !faiDomande) note.push(`✏️ Fuori per nome troppo lungo:\n${prep.senzaNome.join("\n")}`);
    // Nomi troppo lunghi e loghi mancanti: domande una alla volta, a coda finita il carosello si rifà da solo
    const domande: Domanda[] = [
      ...prep.mancanti.map((p): Domanda => ({ tipo: "risultato", nome: partitaTxt(p), id: p.id })),
      ...prep.senzaNome.map((nome): Domanda => ({ tipo: "alias", nome, logoUrl: prep.urlLogo[nome] })),
      ...prep.senzaLogo.map((nome): Domanda => ({ tipo: "logo", nome })),
    ];
    if (prep.senzaCategoria.length) await proponiCampionati(prep.senzaCategoria, chatId, "carosello", giorni);
    // Domande subito, prima delle grafiche: in fondo si perdevano se la funzione finiva il tempo (Giravolta, 2026-10-21)
    if (faiDomande) await chiedi(chatId, domande, "carosello", giorni, richiedente);

    if (!prep.righe.length) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: [`Nessun risultato da pubblicare tra ${ggmm(da)} e ${ggmm(a)}.`, ...note].join("\n\n"),
      });
      return;
    }

    const date = prep.righe.map((r) => r.data).sort();
    const etichetta = etichettaDate(date[0], date[date.length - 1]);
    const slide: Riga[][] = [];
    for (let i = 0; i < prep.righe.length; i += PER_SLIDE) slide.push(prep.righe.slice(i, i + PER_SLIDE));

    const immagini: Buffer[] = [];
    const design: string[] = [];
    for (const [i, s] of slide.entries()) {
      // Barra gialla: data di esecuzione (es. 01 Ottobre). Il periodo delle partite resta nel titolo del design
      const campi: Record<string, string> = { DATA: giornoMese(a) };
      const loghi: Record<string, string> = {};
      s.forEach((r, j) => {
        const n = j + 1;
        Object.assign(campi, {
          [`R${n}_CAT`]: r.cat,
          [`R${n}_CASA`]: r.casa,
          [`R${n}_PC`]: String(r.pc),
          [`R${n}_PO`]: String(r.po),
          [`R${n}_OSP`]: r.ospite,
        });
        if (r.logoCasa) loghi[`R${n}_LCASA`] = r.logoCasa;
        if (r.logoOspite) loghi[`R${n}_LOSP`] = r.logoOspite;
      });
      const id = await autofillCampi(TEMPLATE[s.length], `Risultati ${etichetta} ${date[0].slice(0, 4)} (${i + 1}/${slide.length})`, campi, loghi);
      design.push(id);
      immagini.push(await esportaImmagine(id));
    }

    await inviaAlbum(chatId, immagini, `Risultati ${giornoMese(a)}`);
    // Controllo dati: ogni dubbio sui portali toglie la pubblicazione automatica
    const avvisi = [
      ...agg.errori.map((e) => `portale non letto, ${e}`),
      ...(prep.senzaCategoria.length ? [`${prep.senzaCategoria.length} campionati sconosciuti: partite escluse`] : []),
      ...(prep.mancanti.length ? [`${prep.mancanti.length} partite senza risultato sul portale${faiDomande ? `: chiesto ${dove}, dopo la risposta arriva la versione completa` : ""}`] : []),
      ...(faiDomande && domande.length ? [`mancano ${domande.length} tra loghi e nomi corti: dopo le risposte arriva la versione completa`] : []),
    ];
    await proponiInstagram(chatId, immagini, `Risultati ${giornoMese(a)}`, { auto: true, flusso: "carosello", avvisi, rifatto: !faiDomande }).catch((e) => avvisaAdmin(`⚠️ Bottone Instagram non proposto: ${(e as Error).message}`));
    if (note.length) await tg("sendMessage", { chat_id: chatId, text: note.join("\n\n") });

    for (const id of design) await spostaInCartella(id).catch(() => {});
  } catch (e) {
    console.error(e);
    await tg("sendMessage", { chat_id: chatId, text: "⚠️ Errore nella creazione del carosello, riprova tra poco." }).catch(() => {});
    if (e instanceof CanvaAuthError) {
      const link = `${process.env.BASE_URL}/api/canva-auth?key=${process.env.SETUP_SECRET}`;
      await avvisaAdmin(`🔑 Serve rifare il login Canva. Apri:\n${link}\n\nDettaglio: ${e.message}`);
    } else {
      await avvisaAdmin(`❌ Carosello, errore:\n${e instanceof Error ? e.stack || e.message : e}`);
    }
  } finally {
    if (statusMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  }
}
