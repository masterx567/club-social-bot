import pkg from "../package.json";
import { waitUntil } from "@vercel/functions";
import { SPORT, etichetta, riconosci } from "../lib/categorie";
import { delStato, getStato, redis, setStato, type Ente, type Stato } from "../lib/store";
import { K_GENERALE, ricordaGenerale, avvisaAdmin, griglia, inviaFoto, scaricaFile, tg } from "../lib/telegram";
import { inviaReport, raccogli } from "../lib/metriche";
import { finestra, inviaPeriodo, type Periodo } from "../lib/report";
import { promemoriaRisultati } from "../lib/promemoria";
import { conta } from "../lib/eventi";
import { catBreve, generaSettimana, logoSquadra, salvaLogo } from "../lib/settimana";
import { rispondi as rispondiDomanda, setReferente, suLogoTrovato, suSaltaQuesta, suSaltaTutte } from "../lib/domande";
import { Richiesta, Tipo, copertinaPropria, generaEvento, generaGrafica, generaPostFoto } from "../lib/pipeline";
import { ESEMPIO, Punteggio, leggiPunteggio } from "../lib/punteggio";
import { generaCarosello } from "../lib/carosello";
import { MAX_NOME, Partita, categoriaDi, nomeGrafica, partiteRecenti, setAlias } from "../lib/partite";
import { aggiungiFoto, elencoCoda, postInCoda, suAnnullaInstagram, suBottoneInstagram, suDidascalia, suModificaDidascalia, suBozza, suModificaFoto, suPubblicaSubito, suPubblicaTesto, suTogliDallaCoda, suTogliUltima } from "../lib/instagram";
import { NOMI, idArgomento, nelThread } from "../lib/argomenti";
const threadDi = (m: any): number | undefined => m.message_thread_id;
import { suCampionato } from "../lib/campionati";
import { suBottoneAccount, suRispostaAccount } from "../lib/account";
import { suBottonePipeline } from "../lib/pipeline-github";
import { anteprima, suBottoneInvio, suBottoneNews, suMandaSubito, suToggleNews } from "../lib/newsletter";
import { CHAT_PROVA, inProva, v3 } from "../lib/prova";
import { programmaChiusuraMenu, pulisciManuali, resetSePossibile } from "../lib/reset";

// /risultato può stare ovunque nella didascalia, non solo all'inizio
const COMANDO = /\/(risultato|amichevole)(@\w+)?\b/i;

// Più il gruppo di prova (lib/prova.ts), che non sta nella variabile: cambiarla richiederebbe un passaggio su Vercel
const chatAutorizzate = () => [...(process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()), String(CHAT_PROVA)];

export async function POST(req: Request) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json();
  // Telegram ripete l'update se la risposta tarda (foto aggiunte, pubblicazioni lunghe): ogni update una volta sola
  if (update.update_id && !(await redis.set(`upd:${update.update_id}`, 1, { nx: true, ex: 3600 }))) return new Response("ok");
  // Gruppo a argomenti: si risponde nell'argomento del messaggio (Generale = nessun thread)
  const msg = update.callback_query?.message ?? update.message;
  const thread = msg?.is_topic_message ? msg.message_thread_id : undefined;
  if (update.message) await ricordaGenerale(update.message.chat.id, thread, update.message);
  try {
    await nelThread(thread, async () => {
      if (update.callback_query) await suBottone(update.callback_query);
      else if (update.message) await suMessaggio(update.message);
    });
  } catch (e) {
    console.error(e); // rispondiamo 200 comunque: Telegram altrimenti ripete l'update all'infinito
  }
  return new Response("ok");
}

async function suMessaggio(m: any) {
  const chatId: number = m.chat.id;
  const userId: number = m.from?.id;
  const testo: string = m.text || m.caption || "";

  // /id funziona ovunque: serve per configurare ALLOWED_CHAT_IDS / ADMIN_CHAT_ID
  if (/^\/id(@\w+)?\b/i.test(testo)) {
    await rispondi(m, `ID chat: ${chatId}${m.is_topic_message ? `\nID argomento: ${m.message_thread_id}` : ""}`);
    return;
  }
  const img: string | undefined = m.photo
    ? m.photo[m.photo.length - 1].file_id
    : m.document?.mime_type?.startsWith("image/")
      ? m.document.file_id
      : undefined;

  // Risposte alle domande del bot (loghi, nomi corti). Prima del controllo chat:
  // in privato la conversazione l'ha aperta il bot, la chat non è in ALLOWED_CHAT_IDS
  if (userId && (await rispondiDomanda(m, img, async (nome, fileId) => salvaLogo(nome, await scaricaFile(fileId))))) return;

  if (!userId || !chatAutorizzate().includes(String(chatId))) {
    console.log(`ignorato: chat ${chatId} non autorizzata`);
    return;
  }

  // Gruppo di prova: solo i flussi dei post manuali. I comandi che toccano coda, caroselli, newsletter o argomenti
  // del gruppo vero non partono da qui (la coda e gli argomenti salvati sono quelli del gruppo vero)
  if (inProva(chatId) && /^\s*\/\w/.test(testo) && !/^\s*\/(annulla|salta|risultato|amichevole|carosello|settimana|newsletter|notizie|reset|fine|metriche|promemoria|versione)(@\w+)?\b/i.test(testo)) {
    await rispondi(m, "🧪 In gruppo di prova questo comando non è attivo.");
    return;
  }

  // /versione: la versione del bot in uso
  if (/^\/versione(@\w+)?\s*$/i.test(testo)) {
    await rispondi(m, `🏷 Bot v${pkg.version}`);
    return;
  }

  if (/^\/annulla(@\w+)?\b/i.test(testo)) {
    await conta("annulla", chatId);
    await delStato(chatId, userId);
    await rispondi(m, "Richiesta annullata.");
    return;
  }

  // Risposta a "🛡 Manca il logo di X" di una copertina risultato: immagine o /salta
  if (m.reply_to_message && (await suLogoMancante(m, img))) return;

  // 📸 Account Instagram di una squadra avversaria (tag, Issue 10): risposta dell'admin in privato
  if (m.reply_to_message && (await suRispostaAccount(m))) return;

  // Didascalia di un post manuale o evento, scritta in risposta alla domanda "✍️ Scrivi la didascalia"
  if (await suDidascalia(m)) return;

  // Foto in risposta a una copertina (o nello stesso album di una che lo è): si aggiunge al suo carosello
  // Una foto con un comando in didascalia (/evento, /risultato…) è una richiesta nuova, mai una foto da aggiungere
  if (img && !COMANDO.test(testo) && !/^\s*\/\w/.test(testo) && (m.reply_to_message || m.media_group_id) && (await aggiungiFoto(m, img, scaricaFile))) return;
  // Video in risposta alla copertina: slide video del carosello (2026-10-17). Come file la durata non c'è: la controlla Instagram
  const vid = m.video ?? (m.document?.mime_type?.startsWith("video/") ? m.document : undefined);
  if (vid && !/^\s*\/\w/.test(testo) && (m.reply_to_message || m.media_group_id)) {
    if (await aggiungiFoto(m, vid.file_id, scaricaFile, { durata: vid.duration ?? 10, byte: vid.file_size, larghezza: vid.width, altezza: vid.height })) return;
  }

  // /carosello [giorni]: risultati degli ultimi N giorni (default 7) dai portali → album pronto da pubblicare
  const car = testo.match(/^\/carosello(?:@\w+)?(?:\s+(\d{1,2}))?\s*$/i);
  if (car) {
    const giorni = Number(car[1] || 7);
    const status = await rispondi(m, `⏳ Leggo i portali e preparo il carosello (ultimi ${giorni} giorni)… (circa 2 minuti)`);
    await setReferente(userId);
    waitUntil(generaCarosello(chatId, giorni, status.message_id, userId));
    return;
  }

  // /settimana [giorni]: partite dei prossimi N giorni (default 7, da domani) → album pronto da pubblicare
  const set = testo.match(/^\/settimana(?:@\w+)?(?:\s+(\d{1,2}))?\s*$/i);
  if (set) {
    const giorni = Number(set[1] || 7);
    const status = await rispondi(m, `⏳ Leggo i portali e preparo le partite dei prossimi ${giorni} giorni… (circa 2 minuti)`);
    await setReferente(userId);
    waitUntil(generaSettimana(chatId, giorni, status.message_id, userId));
    return;
  }

  // /reset (2026-10-25): finiti i post manuali, svuota l'argomento ✍️ Post manuali. Telegram non fa
  // cancellare la cronologia ai bot (solo messaggi di meno di 48 ore, uno per uno): si cancella l'argomento e si
  // ricrea con lo stesso nome. La guida è fissata nel Generale e non si tocca. Solo con la coda vuota.
  if (/^\/reset(@\w+)?\s*$/i.test(testo)) {
    // La coda è quella del gruppo vero: dal gruppo di prova non conta
    const n = inProva(chatId) ? 0 : await postInCoda();
    if (n) {
      await rispondi(m, `⏳ Ci sono ancora ${n} post in coda. /reset si può fare quando sono usciti tutti (vedi /coda).`);
      return;
    }
    // Un solo /reset alla volta: due insieme lasciavano un ✍️ Post manuali doppio (2026-10-26)
    if (!(await redis.set(`reset:lock:${chatId}`, 1, { nx: true, ex: 120 }))) return;
    try {
      // /reset scritto dentro un ✍️ Post manuali che il bot non conosce più (doppione): si cancella anche quello
      const noti = Object.values((await redis.hgetall<Record<string, number>>(inProva(chatId) ? `argomenti:${chatId}` : "argomenti")) || {}).map(Number);
      const qui = threadDi(m);
      if (qui && !noti.includes(qui)) await tg("deleteForumTopic", { chat_id: chatId, message_thread_id: qui }).catch(() => {});
      const { vecchio } = await pulisciManuali(chatId);
      const fatto = inProva(chatId) ? "🧹 Fatto: ✍️ Post manuali pulito." : "🧹 Fatto: Generale e ✍️ Post manuali puliti. La guida fissata resta.";
      if (!threadDi(m)) await tg("sendMessage", { chat_id: chatId, text: fatto }).catch(() => {});
      // Scritto dentro ✍️ Post manuali: niente "Fatto" lì, l'argomento appena pulito resta vuoto
      else if (vecchio !== threadDi(m)) await rispondi(m, fatto).catch(() => {});
    } catch (e) {
      await rispondi(m, `⚠️ Non riesco a pulire: ${(e as Error).message}
Serve che il bot sia amministratore con il permesso Elimina messaggi.`).catch(() => {});
    }
    return;
  }

  // /coda: post in attesa di pubblicazione e orari previsti (un post ogni 7 ore)
  if (/^\/coda(@\w+)?\s*$/i.test(testo)) {
    await rispondi(m, await elencoCoda());
    return;
  }

  // Solo gruppo di prova: /fine fa come la coda finita senza errori, cioè prova il reset automatico (3.0)
  if (inProva(chatId) && /^\/fine(@\w+)?\s*$/i.test(testo)) {
    const esito = await resetSePossibile(chatId);
    if (esito !== "fatto") await rispondi(m, `🧪 Reset automatico ${esito}. Riprovo da solo tra 30 minuti.`);
    return;
  }

  // Solo gruppo di prova: /notizie legge la home CSI come il cron del mattino (3.0: importanti subito, le altre in silenzio)
  if (inProva(chatId) && /^\/notizie(@\w+)?\s*$/i.test(testo)) {
    const n = await (await import("../lib/news-csi")).pubblicaNuove(chatId);
    const settimana = await redis.scard(`nl:settimana:${chatId}`);
    await rispondi(m, `🧪 Notizie lette: ${n} importanti mandate qui, ${settimana} in tutto nella newsletter della settimana. /newsletter per l'anteprima.`);
    return;
  }

  // /newsletter: anteprima subito con le news scelte (📧), senza aspettare il venerdì. Stesso ❌/✅ e invio dopo 30 min
  if (/^\/newsletter(@\w+)?\s*$/i.test(testo)) {
    const n = await anteprima(chatId);
    if (!n) await rispondi(m, "Nessuna notizia scelta. Tocca 📧 sotto le notizie in 📰 RSS CSI, poi riscrivi /newsletter");
    return;
  }

  // 3.0: /promemoria = l'avviso del lunedì sera sui risultati mancanti, a richiesta (per le prove e se serve)
  if (v3(chatId) && /^\/promemoria(@\w+)?\s*$/i.test(testo)) {
    waitUntil(
      promemoriaRisultati(chatId)
        .then((n) => (n ? undefined : rispondi(m, "✅ Nessun risultato mancante questa settimana.")))
        .catch((e) => avvisaAdmin(`⚠️ /promemoria: ${(e as Error).message}`)),
    );
    return;
  }

  // 3.0: /metriche mese|trimestre|semestre|stagione = periodo in corso fino a oggi, con "Cosa tira" (statistiche 2026-10-27)
  const per = v3(chatId) && testo.match(/^\/metriche(?:@\w+)?\s+(mese|trimestre|semestre|stagione)\s*$/i);
  if (per) {
    const status = await rispondi(m, `⏳ Preparo le statistiche: ${per[1].toLowerCase()}…`);
    waitUntil(
      (async () => {
        const errori = await inviaPeriodo(chatId, finestra(per[1].toLowerCase() as Periodo)!).catch((e) => [`${(e as Error).message}`]);
        await tg("deleteMessage", { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        if (errori.length) await avvisaAdmin(`⚠️ /metriche ${per[1]}, metriche non lette:\n${errori.join("\n")}`);
      })(),
    );
    return;
  }

  // /metriche [giorni]: statistiche Instagram + Facebook degli ultimi N giorni (default 30, max 30 per Meta)
  const met = testo.match(/^\/metriche(?:@\w+)?(?:\s+(\d{1,2}))?\s*$/i);
  if (met) {
    const giorni = Math.min(30, Number(met[1] || 30));
    const status = await rispondi(m, `⏳ Leggo le statistiche degli ultimi ${giorni} giorni…`);
    waitUntil(
      (async () => {
        const a = new Date();
        const da = new Date(a.getTime() - giorni * 86_400_000);
        // Confronto con gli N giorni prima, come nel report mensile (2026-10-20)
        const [r, prima] = await Promise.all([raccogli(da, a), raccogli(new Date(da.getTime() - giorni * 86_400_000), da).catch(() => undefined)]);
        if (prima && (prima.ig || prima.fb)) Object.assign(r, { prima, primaNome: `ai ${giorni} giorni prima` });
        await inviaReport(chatId, r);
        await tg("deleteMessage", { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        if (r.errori.length) await avvisaAdmin(`⚠️ /metriche, metriche non lette:\n${r.errori.join("\n")}`);
      })(),
    );
    return;
  }

  // /logo NOME come didascalia di un'immagine: logo a mano, senza aspettare la domanda del bot
  const lg = testo.match(/^\/logo(?:@\w+)?\s+(.+?)\s*$/i);
  if (lg) {
    if (!img) {
      await rispondi(m, "Manda il logo come immagine (meglio file PNG) con didascalia /logo NOME");
      return;
    }
    await salvaLogo(lg[1].toUpperCase(), await scaricaFile(img));
    await rispondi(m, `✅ Logo salvato per ${lg[1].toUpperCase()}`);
    return;
  }

  // /alias NOME SUL PORTALE = NOME CORTO
  const al = testo.match(/^\/alias(?:@\w+)?\s+(.+?)\s*=\s*(.+?)\s*$/i);
  if (al) {
    const corto = al[2].toUpperCase();
    if (corto.length > MAX_NOME) {
      await rispondi(m, `"${corto}" è lungo ${corto.length} caratteri, il massimo è ${MAX_NOME}.`);
      return;
    }
    await setAlias(al[1], corto);
    await rispondi(m, `✅ ${al[1].toUpperCase()} → ${corto}`);
    return;
  }

  // Avvio: foto (compressa o come file immagine) con didascalia /risultato
  const fileId: string | undefined = m.photo
    ? m.photo[m.photo.length - 1].file_id
    : m.document?.mime_type?.startsWith("image/")
      ? m.document.file_id
      : undefined;

  // /evento come didascalia della foto: titolo giallo (es. WINNERS CUP) e sottotitolo bianco (2026-10-11).
  // Due righe dopo /evento = titolo + sottotitolo, si parte subito. Una riga = sottotitolo, si chiede solo il titolo.
  // Niente = il bot chiede titolo (con bottone Nessuno) e poi sottotitolo, come /risultato.
  const ev = testo.match(/^\/evento(?:@\w+)?[^\S\n]*([\s\S]*)$/i);
  if (ev) {
    if (!fileId) {
      await rispondi(m, "Manda la foto con didascalia /evento 📸");
      return;
    }
    const righe = ev[1].split("\n").map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean);
    const base = { fileId, photoMsgId: m.message_id };
    if (righe.length >= 2) {
      await avviaEvento(m, base, righe[0], righe.slice(1).join(" "));
    } else if (!righe.length) {
      // Solo /evento (2026-10-24): copertina fatta dal bot o foto usata così com'è come copertina
      const prompt = await rispondi(m, "Copertina: la creo io o usi questa foto così com'è?", BOTTONI_SCELTA);
      await setStato(chatId, userId, { ...base, step: "evScelta", promptMsgId: prompt.message_id });
    } else {
      const prompt = await rispondi(m, TESTO_TITOLO, BOTTONE_NESSUNO);
      await setStato(chatId, userId, { ...base, step: "evTitolo", sottotitolo: righe[0], promptMsgId: prompt.message_id });
    }
    return;
  }

  // 3.0 (2026-10-25): basta la foto, senza scrivere niente. Il bot chiede cos'è con tre bottoni.
  // Nei gruppi ad argomenti ogni messaggio "risponde" al primo dell'argomento: quella non è una risposta vera.
  const rispostaVera = m.reply_to_message && !m.reply_to_message.forum_topic_created;
  if (v3(chatId) && fileId && !testo.trim() && !rispostaVera) {
    // Più foto insieme senza risposta: una sola domanda, la prima foto fa da copertina
    if (m.media_group_id && !(await redis.set(`menu:alb:${m.media_group_id}`, 1, { nx: true, ex: 600 }))) return;
    await mostraMenu(m, fileId, !!m.media_group_id);
    return;
  }

  if (COMANDO.test(testo)) {
    if (!fileId) {
      await rispondi(m, "Manda la foto con didascalia /risultato o /amichevole 📸");
      return;
    }
    // La didascalia può contenere già tutto ("Calcio - Open eccellenza 2-1 /risultato"):
    // si chiede solo quello che manca.
    const resto = testo.replace(COMANDO, " ");
    const { sport, categoria } = riconosci(resto);
    // Tolgo i numeri di categoria ("under 14 - 3-1") prima di cercare il punteggio
    const senzaCategoria = resto.replace(/under\s*\d+/gi, " ");
    const punti = leggiPunteggio(senzaCategoria);
    // Debug: punteggio non letto ma ci sono numeri → logga i caratteri non ASCII (trattini strani ecc.)
    if (!punti && /\d/.test(senzaCategoria)) {
      const strani = [...senzaCategoria].filter((c) => c.charCodeAt(0) > 126).map((c) => `${c}=U+${c.charCodeAt(0).toString(16)}`);
      console.log(`punteggio non letto: ${JSON.stringify(senzaCategoria)} | non-ascii: ${strani.join(" ")}`);
    }
    const tipo = testo.match(COMANDO)![1].toLowerCase() as Tipo;
    const base = { fileId, photoMsgId: m.message_id, tipo, punteggio: punti ?? undefined };

    // /risultato senza punteggio in didascalia (2026-10-20): si sceglie la partita dai portali, poi solo il punteggio.
    // Nomi e loghi arrivano dal portale. "➕ Altra partita" (o nessuna partita in elenco) = percorso di prima
    // 3.0: /amichevole senza punteggio = tre domande semplici (squadra nostra, avversario, punteggio)
    if (v3(chatId) && tipo === "amichevole" && !punti) {
      const prompt = await rispondi(m, "Quale squadra nostra?", bottoniSquadre());
      await setStato(chatId, userId, { ...base, step: "squadra", promptMsgId: prompt.message_id });
      return;
    }
    const recenti = tipo === "risultato" && !punti ? await partiteRecenti() : [];
    if (recenti.length) {
      const bottoni = await Promise.all(recenti.map(async (p, i) => [{ text: await bottonePartita(p), callback_data: `rp:${i}` }]));
      bottoni.push([{ text: "➕ Altra partita", callback_data: "rp:x" }]);
      const prompt = await rispondi(m, "Che partita?", bottoni);
      await setStato(chatId, userId, { ...base, step: "partita", scelte: recenti.map((p) => p.id), promptMsgId: prompt.message_id });
      return;
    }

    if (sport && categoria && punti) {
      await avviaGrafica(m, { ...base, sport, categoria }, punti);
    } else if (sport && categoria) {
      const prompt = await rispondi(m, `${etichetta(sport, categoria)}\nScrivi il risultato, es. ${ESEMPIO}`);
      await setStato(chatId, userId, { ...base, step: "risultato", sport, categoria, promptMsgId: prompt.message_id });
    } else if (sport) {
      const bottoni = SPORT[sport].map((c, i) => ({ text: c, callback_data: `c:${sport}:${i}` }));
      const prompt = await rispondi(m, `${sport}: che categoria?`, griglia(bottoni));
      await setStato(chatId, userId, { ...base, step: "categoria", sport, promptMsgId: prompt.message_id });
    } else {
      const bottoni = Object.keys(SPORT).map((s) => ({ text: s, callback_data: `s:${s}` }));
      const prompt = await rispondi(m, "Che sport?", griglia(bottoni));
      await setStato(chatId, userId, { ...base, step: "sport", promptMsgId: prompt.message_id });
    }
    return;
  }

  const st = await getStato(chatId, userId);

  // /evento: risposta alle domande titolo giallo / sottotitolo bianco (qualsiasi testo della stessa persona)
  if ((st?.step === "evTitolo" || st?.step === "evSottotitolo") && m.text && !m.text.startsWith("/")) {
    await suTestoEvento(m, st, m.text.replace(/\s+/g, " ").trim());
    return;
  }

  // 3.0 amichevole o altra partita, domanda 2 di 3: il nome dell'avversario
  if (st?.step === "avversario" && m.text && !m.text.startsWith("/")) {
    const avversario = testo.replace(/\s+/g, " ").trim().toUpperCase().slice(0, 30);
    // Torneo: basta chi organizza, la grafica parte subito (niente punteggio)
    if (st.tipo === "torneo") {
      await delStato(chatId, userId);
      if (st.promptMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
      await avviaGrafica(m, st, { risultato: "", squadraA: "SS CORMANO", squadraB: avversario });
      return;
    }
    if (st.promptMsgId) await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: `${etichetta(st.sport!, st.categoria!)}\nSS CORMANO - ${avversario}\nPunteggio? Prima SS Cormano, es. 2-1` }).catch(() => {});
    await setStato(chatId, userId, { ...st, step: "puntiLV", avversario });
    return;
  }
  // Domanda 3 di 3: il punteggio, SS Cormano per prima (in grafica a sinistra)
  if (st?.step === "puntiLV" && st.avversario && m.text) {
    const r = testo.trim().match(/^(\d{1,3})\s*[-–—−‒:]\s*(\d{1,3})$/);
    if (!r) {
      if (/\d/.test(testo)) await rispondi(m, "Scrivi il punteggio tipo 2-1, prima SS Cormano");
      return;
    }
    await delStato(chatId, userId);
    if (st.promptMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
    await avviaGrafica(m, st, { risultato: `${r[1]} - ${r[2]}`, squadraA: "SS CORMANO", squadraB: st.avversario });
    return;
  }

  // Partita scelta dall'elenco: basta il punteggio, prima la squadra di casa
  if (st?.step === "punti" && st.partita && m.text) {
    const r = testo.trim().match(/^(\d{1,3})\s*[-–—−‒:]\s*(\d{1,3})$/);
    if (!r) {
      if (/\d/.test(testo) || m.reply_to_message?.message_id === st.promptMsgId) await rispondi(m, `Scrivi il punteggio tipo 3-1, prima ${st.partita.casa}`);
      return;
    }
    await delStato(chatId, userId);
    if (st.promptMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
    await avviaGrafica(m, st, { risultato: `${r[1]} - ${r[2]}`, squadraA: st.partita.casa, squadraB: st.partita.ospite }, st.partita);
    return;
  }

  // Attesa del punteggio
  if (st?.step !== "risultato" || !m.text) return;

  const p = leggiPunteggio(testo);
  if (!p) {
    // Nel gruppo si chiacchiera: il suggerimento solo se il messaggio sembra un tentativo di punteggio
    if (/\d/.test(testo) || m.reply_to_message?.message_id === st.promptMsgId) {
      await rispondi(m, `Scrivi il risultato tipo ${ESEMPIO}`);
    }
    return;
  }

  await delStato(chatId, userId);
  if (st.promptMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
  await avviaGrafica(m, st, p);
}

// 3.0: "Quale squadra nostra?" Sport e categoria in un solo tocco (U14 VOLLEY, OPEN ECC. CALCIO…)
const bottoniSquadre = () =>
  griglia(Object.entries(SPORT).flatMap(([sport, cat]) => cat.map((c, i) => ({ text: catBreve(etichetta(sport, c)), callback_data: `a3:${sport}:${i}` }))));

// ---- 3.0: menu sulla foto (2026-10-25) ----
const MENU = [
  [{ text: "🏆 Risultato", callback_data: "m3:r" }],
  [{ text: "📷 Post foto", callback_data: "m3:f" }],
  [{ text: "✖️ Niente", callback_data: "m3:x" }],
];

// Una foto finita in un altro argomento si lavora lo stesso, in ✍️ Post manuali
async function mostraMenu(m: any, fileId: string, album: boolean) {
  const chatId: number = m.chat.id;
  const manuali = await idArgomento("manuali", chatId);
  const altrove = manuali !== undefined && threadDi(m) !== manuali;
  const testo = `${altrove ? "📷 Foto arrivata in un altro argomento: continuo qui.\n\n" : ""}📷 Cos'è questa foto?${album ? "\nUso la prima come copertina: le altre mandale dopo, in risposta alla copertina." : ""}`;
  const manda = () =>
    tg<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: testo,
      ...(altrove ? {} : { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }),
      reply_markup: { inline_keyboard: MENU },
    });
  const prompt = altrove ? await nelThread(manuali, manda) : await manda();
  // Da un altro argomento la copertina risponde al messaggio del menu: la foto sta in un argomento diverso
  await setStato(chatId, m.from.id, { step: "menu", fileId, photoMsgId: altrove ? prompt.message_id : m.message_id, tipo: "risultato", promptMsgId: prompt.message_id });
  await programmaChiusuraMenu(chatId, m.from.id, prompt.message_id).catch(() => {});
  await conta("menu_aperto", chatId);
}

async function suMenu(q: any, st: Stato, scelta: string) {
  const chatId: number = q.message.chat.id;
  const userId: number = q.from.id;
  await conta(scelta === "x" ? "menu_niente" : scelta === "f" ? "menu_foto" : "menu_risultato", chatId);
  if (scelta === "x") {
    await delStato(chatId, userId);
    await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
    return;
  }
  if (scelta === "f") {
    await delStato(chatId, userId);
    await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
    const status = await tg<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: "⏳ Preparo il post…",
      reply_parameters: { message_id: st.photoMsgId, allow_sending_without_reply: true },
    });
    waitUntil(generaPostFoto({ chatId, fileId: st.fileId, photoMsgId: st.photoMsgId, statusMsgId: status.message_id }));
    return;
  }
  // 🏆 Risultato: le partite della settimana dai portali, in fondo amichevole, torneo o altra partita.
  // Torneo (2026-11-01): come l'amichevole, template con scritto TORNEO. I tre bottoni ci sono anche
  // quando l'elenco è vuoto (prima si passava diretti a "Che sport?" e l'amichevole non si poteva scegliere).
  const recenti = await partiteRecenti();
  const bottoni = await Promise.all(recenti.map(async (p, i) => [{ text: await bottonePartita(p), callback_data: `rp:${i}` }]));
  bottoni.push([{ text: "🤝 Amichevole", callback_data: "rp:a" }, { text: "🏅 Torneo", callback_data: "rp:t" }], [{ text: "➕ Altra partita", callback_data: "rp:x" }]);
  await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: "Che partita?", reply_markup: { inline_keyboard: bottoni } });
  await setStato(chatId, userId, { ...st, step: "partita", scelte: recenti.map((p) => p.id) });
}

async function avviaGrafica(
  m: any,
  st: { fileId: string; photoMsgId: number; sport?: string; categoria?: string; tipo?: Tipo; ente?: Ente },
  punteggio: Punteggio,
  partita?: Stato["partita"],
) {
  await preparaGrafica({
    chatId: m.chat.id,
    fileId: st.fileId,
    photoMsgId: st.photoMsgId,
    categoria: etichetta(st.sport!, st.categoria!),
    tipo: st.tipo ?? "risultato",
    ...punteggio,
    urlA: partita?.logoCasa,
    urlB: partita?.logoOspite,
    ente: partita?.ente ?? st.ente,
  });
}

// Copertina in preparazione: urlA/urlB = loghi sul portale, saltati = squadre per cui si è scelto /salta (resta il nome)
type Grafica = Omit<Richiesta, "statusMsgId" | "logoA" | "logoB"> & { urlA?: string; urlB?: string; saltati?: string[] };
const kLogoMancante = (chat: number, msg: number) => `rlogo:${chat}:${msg}`;

// Loghi squadra al posto dei nomi (2026-10-20). Se ne manca uno lo chiedo qui nel gruppo, nello stesso argomento:
// si risponde con l'immagine (salvata per le prossime volte) o con /salta, e allora resta il nome.
async function preparaGrafica(g: Grafica) {
  const status = await tg<{ message_id: number }>("sendMessage", {
    chat_id: g.chatId,
    text: "⏳ Creo la grafica…",
    reply_parameters: { message_id: g.photoMsgId, allow_sending_without_reply: true },
  });
  // La risposta al webhook parte subito, loghi e pipeline (10-20s) continuano in background
  waitUntil(
    (async () => {
      const saltati = g.saltati ?? [];
      const logo = (nome: string, url?: string) => (saltati.includes(nome) ? null : logoSquadra(nome, url).catch(() => null));
      const [logoA, logoB] = await Promise.all([logo(g.squadraA, g.urlA), logo(g.squadraB, g.urlB)]);
      const manca = [!logoA && g.squadraA, !logoB && g.squadraB].find((n): n is string => !!n && !saltati.includes(n));
      if (manca) {
        // Torneo: il logo di chi organizza prima lo cerco online (2026-11-01), come per i caroselli
        const online = g.tipo === "torneo" && manca === g.squadraB ? await cercaLogoTorneo(g, manca, status.message_id) : false;
        if (online === "trovato") return;
        await tg("editMessageText", {
          chat_id: g.chatId,
          message_id: status.message_id,
          text: `${online === "cercato" ? `🔎 Non ho trovato online il logo di ${manca}: mandalo tu.` : `🛡 Manca il logo di ${manca}.`}\nRispondi a questo messaggio con l'immagine, meglio come file PNG.\n/salta per lasciare il nome.`,
        });
        await redis.set(kLogoMancante(g.chatId, status.message_id), { ...g, manca }, { ex: 86_400 });
        return;
      }
      const { urlA, urlB, saltati: _, ...r } = g;
      await generaGrafica({ ...r, statusMsgId: status.message_id, logoA: logoA ?? undefined, logoB: logoB ?? undefined });
    })(),
  );
}

// true = era la risposta a una domanda sul logo, il chiamante non deve fare altro
async function suLogoMancante(m: any, img?: string): Promise<boolean> {
  const domanda: number = m.reply_to_message.message_id;
  const k = kLogoMancante(m.chat.id, domanda);
  const g = await redis.get<Grafica & { manca: string }>(k);
  if (!g) return false;
  const salta = /^\/salta(@\w+)?$/i.test((m.text || m.caption || "").trim());
  if (!salta && !img) {
    await rispondi(m, `Mi serve l'immagine del logo di ${g.manca} (o /salta).`);
    return true;
  }
  if (!(await redis.del(k))) return true; // già presa da un'altra risposta
  const { manca, ...resto } = g;
  await conta(salta ? "logo_saltato" : "logo_caricato", m.chat.id);
  if (salta) resto.saltati = [...(resto.saltati ?? []), manca];
  else await salvaLogo(manca, await scaricaFile(img!));
  await tg("editMessageText", { chat_id: m.chat.id, message_id: domanda, text: salta ? `Ok, per ${manca} resta il nome.` : `✅ Logo salvato per ${manca}` }).catch(() => {});
  await preparaGrafica(resto);
  return true;
}

// ---- Torneo: logo di chi organizza cercato online (2026-11-01) ----
// Stessa ricerca dei caroselli (lib/cercalogo.ts, Brave + controllo AI), con una chiave per foto: il logo trovato va
// nel gruppo con ✅ Usa questo (tlok) / 🔄 Un altro (tlnx). Alla proposta si può anche rispondere con l'immagine
// giusta o con /salta (stessa chiave rlogo delle domande sul logo, sul messaggio della proposta).
const kCandTorneo = (g: Grafica) => `t:${g.chatId}:${g.photoMsgId}`;
const sportDi = (g: Grafica) => g.categoria.split(" · ")[1];

// "trovato" = proposta mandata; "cercato" = cercato senza trovarlo; false = ricerca non attiva
async function cercaLogoTorneo(g: Grafica, manca: string, statusId: number): Promise<"trovato" | "cercato" | false> {
  const { prossimoLogo, ricercaAttiva } = await import("../lib/cercalogo");
  if (!ricercaAttiva()) return false;
  await tg("editMessageText", { chat_id: g.chatId, message_id: statusId, text: `🔎 Cerco online il logo di ${manca}… (al massimo un minuto)` }).catch(() => {});
  const t = await prossimoLogo(kCandTorneo(g), manca, undefined, sportDi(g)).catch((e) => (console.error("logo torneo", e), null));
  if (!t) return "cercato";
  await tg("deleteMessage", { chat_id: g.chatId, message_id: statusId }).catch(() => {});
  await proponiLogoTorneo(g, manca, t.img);
  return "trovato";
}

async function proponiLogoTorneo(g: Grafica, manca: string, img: Buffer) {
  const jpg = await (await import("sharp")).default(img).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const caption = `🛡 Logo di ${manca}: l'ho trovato online, è quello giusto?\nSe no, rispondi a questo messaggio con l'immagine giusta, oppure /salta per lasciare il nome.`;
  const tastiera = [[{ text: "✅ Usa questo", callback_data: "tlok" }, { text: "🔄 Un altro", callback_data: "tlnx" }]];
  const id = await inviaFoto(g.chatId, jpg, caption, g.photoMsgId, tastiera);
  await redis.set(kLogoMancante(g.chatId, id), { ...g, manca }, { ex: 86_400 });
}

async function suLogoTorneo(q: any) {
  const chatId: number = q.message.chat.id;
  const k = kLogoMancante(chatId, q.message.message_id);
  const g = await redis.get<Grafica & { manca: string }>(k);
  if (!g) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Questa domanda è già chiusa." });
    return;
  }
  const { candidatoAttuale, dimenticaCandidati, scaricaImmagine, prossimoLogo } = await import("../lib/cercalogo");
  const { manca, ...resto } = g;
  if (q.data === "tlnx") {
    if (!(await redis.del(k))) return;
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🔎 Cerco un altro logo…" });
    await tg("deleteMessage", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    // La ricerca può durare fino a 40 secondi: il webhook risponde subito
    waitUntil(
      (async () => {
        const t = await prossimoLogo(kCandTorneo(resto), manca, undefined, sportDi(resto)).catch(() => null);
        if (t) return proponiLogoTorneo(resto, manca, t.img);
        await dimenticaCandidati(kCandTorneo(resto));
        const m = await tg<{ message_id: number }>("sendMessage", {
          chat_id: chatId,
          text: `🔎 Non ho trovato online altri loghi di ${manca}: mandalo tu.\nRispondi a questo messaggio con l'immagine, meglio come file PNG.\n/salta per lasciare il nome.`,
          reply_parameters: { message_id: resto.photoMsgId, allow_sending_without_reply: true },
        });
        await redis.set(kLogoMancante(chatId, m.message_id), g, { ex: 86_400 });
      })(),
    );
    return;
  }
  const url = await candidatoAttuale(kCandTorneo(resto));
  const img = url ? await scaricaImmagine(url) : null;
  if (!img) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Non riesco più a scaricare questo logo: tocca 🔄 Un altro o mandalo tu.", show_alert: true });
    return;
  }
  if (!(await redis.del(k))) return; // già presa da un altro tocco
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Logo salvato" });
  await tg("editMessageCaption", { chat_id: chatId, message_id: q.message.message_id, caption: `✅ Logo salvato per ${manca}`, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await dimenticaCandidati(kCandTorneo(resto));
  await conta("logo_caricato", chatId);
  await salvaLogo(manca, img);
  await preparaGrafica(resto);
}

// "SAB 17/10 · U13 VOLLEY · PRECOTTO RGP - SSC": giorno, categoria, casa - ospite
const GIORNI = ["DOM", "LUN", "MAR", "MER", "GIO", "VEN", "SAB"];
async function bottonePartita(p: Partita) {
  const nome = async (n: string) => ((await nomeGrafica(n)) === "SS CORMANO" ? "SSC" : nomeGrafica(n));
  const giorno = GIORNI[new Date(`${p.data}T12:00:00Z`).getUTCDay()];
  return `${giorno} ${p.data.slice(8, 10)}/${p.data.slice(5, 7)} · ${catBreve(categoriaDi(p)!.etichetta)} · ${await nome(p.casa)} - ${await nome(p.ospite)}`;
}

// /evento guidato: titolo giallo (o Nessuno), poi sottotitolo bianco
const TESTO_TITOLO = "Scrivi il titolo giallo, es. WINNERS CUP\noppure tocca Nessuno";
const TESTO_SOTTOTITOLO = "Scrivi il sottotitolo bianco, es. SS CORMANO & PANZEROTTI: UN GEMELLAGGIO SPECIALE!";
const BOTTONE_NESSUNO = [[{ text: "Nessuno", callback_data: "evn" }]];
const BOTTONI_SCELTA = [[{ text: "🎨 Creala tu", callback_data: "evc:c" }], [{ text: "🖼 Uso questa foto", callback_data: "evc:m" }]];

async function suTestoEvento(m: any, st: Stato, testo: string) {
  if (st.step === "evTitolo") return passaTitolo(m, st, testo);
  await chiudiEvento(m.chat.id, m.from.id, st);
  await avviaEvento(m, st, st.titolo ?? "", testo);
}

// Titolo scelto ("" = nessuno): se il sottotitolo c'era già nella didascalia si parte, altrimenti si chiede
async function passaTitolo(m: any, st: Stato, titolo: string, chatId: number = m.chat.id, userId: number = m.from.id) {
  if (st.sottotitolo) {
    await chiudiEvento(chatId, userId, st);
    await avviaEvento(m, st, titolo, st.sottotitolo);
    return;
  }
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: st.promptMsgId,
    text: `${titolo ? `Titolo: ${titolo.toUpperCase()}` : "Nessun titolo giallo"}\n${TESTO_SOTTOTITOLO}`,
  }).catch(() => {});
  await setStato(chatId, userId, { ...st, step: "evSottotitolo", titolo });
}

async function chiudiEvento(chatId: number, userId: number, st: Stato) {
  await delStato(chatId, userId);
  if (st.promptMsgId) await tg("deleteMessage", { chat_id: chatId, message_id: st.promptMsgId }).catch(() => {});
}

async function avviaEvento(m: any, st: { fileId: string; photoMsgId: number }, titolo: string, sottotitolo: string) {
  // In risposta alla foto: il messaggio con la domanda a questo punto è già cancellato
  const status = await rispondi({ chat: m.chat, message_id: st.photoMsgId }, "⏳ Creo la grafica…");
  waitUntil(
    generaEvento({
      chatId: m.chat.id,
      fileId: st.fileId,
      photoMsgId: st.photoMsgId,
      statusMsgId: status.message_id,
      titolo: titolo.toUpperCase(),
      sottotitolo: sottotitolo.toUpperCase(),
    }),
  );
}

async function suBottone(q: any) {
  const chatId: number = q.message?.chat.id;
  const userId: number = q.from.id;
  // ✏️ Modifica didascalia di un post non ancora pubblicato: chiunque nel gruppo
  // 🗂 Campionato nuovo: conferma della categoria, solo dall'admin
  // Pipeline degli aggiornamenti: ✅ Scegli / 🚀 Rilascia nei messaggi privati all'admin
  if (String(q.data).startsWith("gh:")) {
    await suBottonePipeline(q);
    return;
  }
  if (String(q.data).startsWith("iga:")) {
    if (String(chatId) === String(process.env.ADMIN_CHAT_ID)) await suBottoneAccount(q);
    return;
  }
  if (String(q.data).startsWith("cmp:")) {
    if (String(chatId) === String(process.env.ADMIN_CHAT_ID)) await suCampionato(q);
    return;
  }
  // 🤖 Bozza AI: ✅ Usa questa / 🔄 Un'altra
  // 3.0: ⏭ Salta tutte sull'elenco delle domande dei caroselli
  // Logo trovato online: ✅ Usa questo / 🔄 Un altro (2026-10-29). Vale anche dalla chat privata del referente
  // Torneo: ✅ Usa questo / 🔄 Un altro sul logo di chi organizza (2026-11-01)
  if (/^tl(ok|nx)$/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await suLogoTorneo(q);
    return;
  }
  if (/^lg(ok|nx):/.test(String(q.data))) {
    await suLogoTrovato(q);
    return;
  }
  if (String(q.data).startsWith("dsk:")) {
    if (chatAutorizzate().includes(String(chatId))) await suSaltaTutte(q);
    return;
  }
  if (String(q.data).startsWith("dsq:")) {
    if (chatAutorizzate().includes(String(chatId))) await suSaltaQuesta(q);
    return;
  }
  // 3.0: ✅ Pubblica con questo testo / 📝 Usa il mio testo così com'è (scheda unica)
  if (/^ig(p3|my):/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await suPubblicaTesto(q);
    return;
  }
  if (/^igb[zrcm]:/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await suBozza(q);
    return;
  }
  if (String(q.data).startsWith("iged:")) {
    if (chatAutorizzate().includes(String(chatId))) await suModificaDidascalia(q);
    return;
  }
  // 🖼 Modifica foto: chiunque nel gruppo
  if (String(q.data).startsWith("igfo:")) {
    if (chatAutorizzate().includes(String(chatId))) await suModificaFoto(q);
    return;
  }
  // Bottone Instagram: vale per chiunque nel gruppo, non legato a una richiesta
  if (String(q.data).startsWith("ig:")) {
    if (chatAutorizzate().includes(String(chatId))) await suBottoneInstagram(q);
    return;
  }
  // ❌ Annulla / Scarta pubblicazione Instagram: chiunque nel gruppo
  if (String(q.data).startsWith("igx:")) {
    if (chatAutorizzate().includes(String(chatId))) await suAnnullaInstagram(q);
    return;
  }
  // Coda di pubblicazione: ❌ Togli dalla coda (igcx:), ⚡ Pubblica subito (igcn:). Chiunque nel gruppo
  if (/^igc[xn]:/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await (String(q.data).startsWith("igcx:") ? suTogliDallaCoda(q) : suPubblicaSubito(q));
    return;
  }
  // 3.0 newsletter: ✖️/➕ su una notizia dell'anteprima (nlt:), 📧 Manda subito su una notizia importante (nlu:)
  if (/^nl[tu]:/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await (String(q.data).startsWith("nlt:") ? suToggleNews(q) : suMandaSubito(q));
    return;
  }
  // Newsletter: 📧 su una news (nl:), ✅/❌ sull'anteprima del venerdì (nlok:/nlx:). Chiunque nel gruppo
  if (/^nl(ok|x)?:/.test(String(q.data))) {
    if (chatAutorizzate().includes(String(chatId))) await (String(q.data).startsWith("nl:") ? suBottoneNews(q) : suBottoneInvio(q));
    return;
  }
  // 🗑 Togli ultima foto dal carosello manuale
  if (String(q.data).startsWith("igdel:")) {
    if (chatAutorizzate().includes(String(chatId))) await suTogliUltima(q);
    return;
  }
  const [tipo, sport, idx] = String(q.data).split(":");
  const st = chatId ? await getStato(chatId, userId) : null;

  // Bottoni di qualcun altro, o richiesta scaduta
  if (!st || st.promptMsgId !== q.message.message_id) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Non è una tua richiesta attiva. Manda la foto con /risultato", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });

  // 3.0: amichevole o partita fuori elenco, domanda 1 di 3 (squadra nostra = sport e categoria insieme)
  if (tipo === "a3" && st.step === "squadra" && SPORT[sport]?.[Number(idx)]) {
    const categoria = SPORT[sport][Number(idx)];
    // Partita fuori elenco: prima il campionato, per il logo in grafica (2026-10-27). Amichevole e torneo non ce l'hanno.
    if (st.tipo !== "amichevole" && st.tipo !== "torneo") {
      const enti = ["CSI", "FIP", "UISP"].map((e) => ({ text: e, callback_data: `en:${e}` }));
      await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: `${etichetta(sport, categoria)}\nChe campionato?`, reply_markup: { inline_keyboard: [enti, [{ text: "Nessuno", callback_data: "en:-" }]] } });
      await setStato(chatId, userId, { ...st, step: "ente", sport, categoria });
      return;
    }
    // Torneo (2026-11-01): niente avversario e niente punteggio, solo chi organizza
    const chiedo = st.tipo === "torneo" ? "Chi organizza il torneo? Scrivi il nome della squadra o della società." : "Contro chi? Scrivi il nome della squadra avversaria.";
    await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: `${etichetta(sport, categoria)}\n${chiedo}` });
    await setStato(chatId, userId, { ...st, step: "avversario", sport, categoria });
    return;
  }

  // 3.0: campionato scelto (en:CSI|FIP|UISP, en:- = nessun logo), poi domanda 2 di 3
  if (tipo === "en" && st.step === "ente") {
    const ente = ["CSI", "FIP", "UISP"].includes(sport) ? (sport as Ente) : undefined;
    await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: `${etichetta(st.sport!, st.categoria!)}${ente ? " · " + ente : ""}\nContro chi? Scrivi il nome della squadra avversaria.` });
    await setStato(chatId, userId, { ...st, step: "avversario", ente });
    return;
  }

  // 3.0: menu sulla foto
  if (tipo === "m3" && st.step === "menu") {
    await suMenu(q, st, sport);
    return;
  }

  // /evento: copertina creata dal bot (si chiede il titolo) o foto propria come copertina
  if (tipo === "evc" && st.step === "evScelta") {
    if (sport === "c") {
      await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: TESTO_TITOLO, reply_markup: { inline_keyboard: BOTTONE_NESSUNO } });
      await setStato(chatId, userId, { ...st, step: "evTitolo" });
      return;
    }
    await chiudiEvento(chatId, userId, st);
    const status = await rispondi({ chat: q.message.chat, message_id: st.photoMsgId }, "⏳ Preparo la copertina…");
    waitUntil(copertinaPropria({ chatId, fileId: st.fileId, photoMsgId: st.photoMsgId, statusMsgId: status.message_id }));
    return;
  }

  // /evento: bottone Nessuno sulla domanda del titolo giallo
  if (tipo === "evn" && st.step === "evTitolo") {
    await passaTitolo(q.message, st, "", chatId, userId);
    return;
  }

  // /risultato: partita scelta dall'elenco (rp:<n>), oppure "➕ Altra partita" (rp:x) = sport, categoria, punteggio come prima
  if (tipo === "rp" && st.step === "partita") {
    const id = st.scelte?.[Number(sport)];
    const p = id ? await redis.hget<Partita>("partite", id) : null;
    const cat = p && categoriaDi(p);
    if (!p || !cat) {
      // 3.0: 🤝 Amichevole (rp:a), 🏅 Torneo (rp:t) o ➕ Altra partita (rp:x) = tre domande semplici: squadra nostra, avversario, punteggio
      if (v3(chatId)) {
        const tipo: Tipo = sport === "a" ? "amichevole" : sport === "t" ? "torneo" : "risultato";
        await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: "Quale squadra nostra?", reply_markup: { inline_keyboard: bottoniSquadre() } });
        await setStato(chatId, userId, { ...st, step: "squadra", tipo });
        return;
      }
      const bottoni = Object.keys(SPORT).map((s) => ({ text: s, callback_data: `s:${s}` }));
      await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: "Che sport?", reply_markup: { inline_keyboard: griglia(bottoni) } });
      await setStato(chatId, userId, { ...st, step: "sport" });
      return;
    }
    const [casa, ospite] = [await nomeGrafica(p.casa), await nomeGrafica(p.ospite)];
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: st.promptMsgId,
      text: `${cat.etichetta}\n${casa} - ${ospite}\nScrivi il punteggio, es. 3-1 (prima ${casa})`,
    });
    await setStato(chatId, userId, { ...st, step: "punti", sport: cat.sport, categoria: cat.categoria, partita: { casa, ospite, logoCasa: p.logoCasa, logoOspite: p.logoOspite, ente: p.ente } });
    return;
  }

  if (tipo === "s" && SPORT[sport]) {
    const bottoni = SPORT[sport].map((c, i) => ({ text: c, callback_data: `c:${sport}:${i}` }));
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: st.promptMsgId,
      text: `${sport}: che categoria?`,
      reply_markup: { inline_keyboard: griglia(bottoni) },
    });
    await setStato(chatId, userId, { ...st, step: "categoria", sport });
  } else if (tipo === "c" && SPORT[sport]?.[Number(idx)]) {
    const categoria = SPORT[sport][Number(idx)];
    if (st.punteggio) {
      // Punteggio già nella didascalia: si parte subito
      await tg("editMessageText", { chat_id: chatId, message_id: st.promptMsgId, text: etichetta(sport, categoria) });
      await delStato(chatId, userId);
      await avviaGrafica(q.message, { ...st, sport, categoria }, st.punteggio);
      return;
    }
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: st.promptMsgId,
      text: `${etichetta(sport, categoria)}\nScrivi il risultato, es. ${ESEMPIO}`,
    });
    await setStato(chatId, userId, { ...st, step: "risultato", sport, categoria });
  }
}

function rispondi(m: any, text: string, keyboard?: unknown) {
  return tg<{ message_id: number }>("sendMessage", {
    chat_id: m.chat.id,
    text,
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}
