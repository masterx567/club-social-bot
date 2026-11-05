import { waitUntil } from "@vercel/functions";
import { MAX_NOME, setAlias } from "./partite";
import { redis } from "./store";
import { tg } from "./telegram";
import { idArgomento, nelThread, nellArgomento } from "./argomenti";
import { v3 } from "./prova";
import { conta } from "./eventi";
import { programmaChiamata } from "./qstash";

// Coda di domande per completare i caroselli: loghi mancanti e nomi troppo lunghi.
// Si fanno una alla volta, in privato al referente (Telegram lo permette solo se ha premuto Avvia nel bot),
// altrimenti nel gruppo. Finita la coda, i caroselli che le hanno generate si rifanno da soli.

// risultato (2026-10-20): partita giocata ma senza punteggio sul portale. Il punteggio dato in chat vale
// solo per il carosello (risman:<id partita>), il portale non si tocca.
// alias.logoUrl: logo della squadra sul portale. Dopo il nome corto si controlla il logo (l'admin 2026-10-29: con nome
// lungo e logo mancante il bot chiedeva solo il nome, e nel giro rifatto il logo non veniva più chiesto)
export type Domanda = { tipo: "logo"; nome: string; lungo?: string } | { tipo: "alias"; nome: string; logoUrl?: string } | { tipo: "risultato"; nome: string; id: string };
export const kRisultatoManuale = (id: string) => `risman:${id}`;
export type Flusso = "settimana" | "carosello";

const kCoda = (chat: number) => `domande:${chat}`;
const kMsg = (chat: number) => `domande:msg:${chat}`; // ultima domanda inviata: nel gruppo vale solo chi risponde a quella
const kFlussi = (chat: number) => `domande:flussi:${chat}`; // flusso -> giorni, da rifare a coda finita
const kGruppo = (chat: number) => `domande:gruppo:${chat}`;
const kRisposte = (chat: number) => `domande:risposte:${chat}`; // quante risposte vere (non /salta)
const TTL = 14 * 86_400;

// Chi riceve le domande in privato: l'ultima persona che ha lanciato un carosello o risposto
export const setReferente = (userId: number) => redis.set("loghi:referente", userId);

const uguale = (a: Domanda, b: Domanda) => a.tipo === b.tipo && a.nome === b.nome;

// Dopo un nome corto: se per quel nome non c'è logo (né salvato né sul portale) serve la domanda sul logo
async function logoDopoAlias(d: Domanda, corto: string): Promise<Domanda | null> {
  if (d.tipo !== "alias") return null;
  const { getLogo, logoDalPortale } = await import("./settimana");
  if ((await getLogo(corto)) || (await logoDalPortale(corto, d.logoUrl))) return null;
  return { tipo: "logo", nome: corto, lungo: d.nome };
}

// ---- Logo trovato online (l'admin 2026-10-29, lib/cercalogo.ts) ----
// Prima di chiedere un logo il bot lo cerca: se ne trova uno che l'AI riconosce, lo mostra con ✅ / 🔄.
// La domanda resta aperta come sempre: si può anche rispondere con l'immagine giusta o con /salta.
// "trovato" = proposto un logo; "cercato" = cercato online senza trovarlo (29/10: allora la domanda lo dice chiaro);
// false = ricerca non fatta (gruppo vero, chiavi mancanti)
async function mandaLogoTrovato(chat: number, d: Domanda, nelTopicV3: boolean): Promise<"trovato" | "cercato" | false> {
  if (d.tipo !== "logo") return false;
  // Provata in gruppo di prova (3.2.0-3.2.4), attiva ovunque dalla 3.3.0 (2026-10-29)
  const { prossimoLogo, ricercaAttiva } = await import("./cercalogo");
  if (!ricercaAttiva()) return false;
  // La ricerca può durare fino a 40 secondi: si dice che il bot ci sta lavorando (29/10: "si impianta")
  const manda = () => tg<{ message_id: number }>("sendMessage", { chat_id: chat, text: `🔎 Cerco online il logo di ${d.nome}… (al massimo un minuto)` });
  const attesa = await (nelTopicV3 ? nelTopic(chat, manda) : manda()).catch(() => null);
  const t = await prossimoLogo(chat, d.nome, d.lungo).catch((e) => (console.error("logo online", e), null));
  if (attesa) await tg("deleteMessage", { chat_id: chat, message_id: attesa.message_id }).catch(() => {});
  if (!t) return "cercato";
  const { inviaFoto } = await import("./telegram");
  const png = await (await import("sharp")).default(t.img).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const caption = `🛡 Logo di ${d.nome}: l'ho trovato online, è quello giusto?\nSe no, rispondi a questo messaggio con l'immagine giusta, oppure /salta.`;
  const tastiera = [[{ text: "✅ Usa questo", callback_data: `lgok:${chat}` }, { text: "🔄 Un altro", callback_data: `lgnx:${chat}` }], ...(nelTopicV3 ? [SALTA(chat)] : [])];
  const invia = () => inviaFoto(chat, png, caption, undefined, tastiera);
  const id = nelTopicV3 ? await nelTopic(chat, invia) : await invia();
  await redis.set(kMsg(chat), id, { ex: TTL });
  return "trovato";
}

// ✅ Usa questo (lgok:<chat>) / 🔄 Un altro (lgnx:<chat>) sul logo trovato online
export async function suLogoTrovato(q: any) {
  const [tipo, c] = String(q.data).split(":");
  const chat = Number(c);
  const d = (await coda(chat))[0];
  const aperta = await redis.get<number>(kMsg(chat));
  if (!d || d.tipo !== "logo" || aperta !== q.message.message_id || q.message.chat.id !== chat) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Questa domanda è già chiusa." });
    return;
  }
  const { candidatoAttuale, dimenticaCandidati, scaricaImmagine } = await import("./cercalogo");
  if (tipo === "lgnx") {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "🔎 Cerco un altro logo…" });
    await tg("deleteMessage", { chat_id: chat, message_id: aperta }).catch(() => {});
    if ((await mandaLogoTrovato(chat, d, v3(chat))) === "trovato") return;
    await dimenticaCandidati(chat);
    // Niente altro online: si torna alla domanda normale
    if (v3(chat)) await inviaV3(chat, d, false, true);
    else {
      const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chat, text: `🔎 Non ho trovato online altri loghi di ${d.nome}: mandalo tu.\nMandami l'immagine in risposta a questo messaggio, meglio come file PNG.\n/salta per lasciare lo scudetto grigio.` });
      await redis.set(kMsg(chat), m.message_id, { ex: TTL });
    }
    return;
  }
  const url = await candidatoAttuale(chat);
  const img = url ? await scaricaImmagine(url) : null;
  if (!img) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Non riesco più a scaricare questo logo: tocca 🔄 Un altro o mandalo tu.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "✅ Logo salvato" });
  await tg("editMessageReplyMarkup", { chat_id: chat, message_id: aperta, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  await dimenticaCandidati(chat);
  // Stessa strada di una risposta con l'immagine: salva, segna fatto, passa alla domanda dopo
  const finta = { chat: q.message.chat, message_id: aperta, text: "", reply_to_message: { message_id: aperta }, from: q.from };
  const { salvaLogo } = await import("./settimana");
  await rispondi(finta, "online", async (nome) => salvaLogo(nome, img));
}
// Mette la domanda sul logo subito dopo quella appena chiusa (va chiamata dopo lpop)
async function metteSubito(chat: number, d: Domanda | null) {
  if (!d || (await coda(chat)).some((p) => uguale(p, d))) return;
  await redis.lpush(kCoda(chat), d);
}

async function coda(chat: number): Promise<Domanda[]> {
  return ((await redis.lrange(kCoda(chat), 0, -1)) as Domanda[]) || [];
}

async function invia(chat: number): Promise<boolean> {
  const tutte = await coda(chat);
  const d = tutte[0];
  if (!d) return false;
  if (v3(chat)) return inviaV3(chat, d);
  const ricerca = await mandaLogoTrovato(chat, d, false);
  if (ricerca === "trovato") return true;
  const n = tutte.length > 1 ? ` (1 di ${tutte.length})` : "";
  const text =
    d.tipo === "risultato"
      ? `⚽ Manca il risultato di ${d.nome}${n}.\nScrivimelo come 3-1 (prima la squadra di casa).\n/salta per lasciare fuori la partita.`
      : d.tipo === "logo"
      ? ricerca === "cercato"
        ? `🔎 Non ho trovato online il logo di ${d.nome}${n}: mandalo tu.\nRispondi a questo messaggio con l'immagine, meglio come file PNG.\n/salta per lasciare lo scudetto grigio.`
        : `🛡 Manca il logo di ${d.nome}${n}.\nMandami l'immagine, meglio come file PNG.\n/salta per lasciare lo scudetto grigio.`
      : `✏️ "${d.nome}" è troppo lungo per la grafica${n}.\nScrivimi il nome corto (max ${MAX_NOME} lettere).\n/salta per lasciare fuori la partita.`;
  const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chat, text });
  await redis.set(kMsg(chat), m.message_id, { ex: TTL });
  return true;
}

// Aggiunge le domande nuove e, se la coda era vuota, fa partire la prima.
// gruppo: dove rifare il carosello; referente: chi l'ha chiesto (dal cron non c'è, si usa l'ultimo)
export async function chiedi(gruppo: number, domande: Domanda[], flusso: Flusso, giorni: number, referente?: number) {
  if (!domande.length) return;
  if (v3(gruppo)) return chiediV3(gruppo, domande, flusso, giorni);
  const dest =referente ?? (await redis.get<number>("loghi:referente"));
  const destinazioni = dest ? [dest, gruppo] : [gruppo];

  for (const chat of destinazioni) {
    const prima = await coda(chat);
    const nuove = domande.filter((d) => !prima.some((p) => uguale(p, d)));
    if (nuove.length) await redis.rpush(kCoda(chat), ...nuove);
    await redis.hset(kFlussi(chat), { [flusso]: giorni });
    await redis.set(kGruppo(chat), gruppo, { ex: TTL });
    for (const k of [kCoda(chat), kFlussi(chat)]) await redis.expire(k, TTL);
    if (prima.length) return; // una domanda è già in attesa: le nuove arrivano dopo
    try {
      await invia(chat);
      if (chat !== gruppo) {
        await tg("sendMessage", { chat_id: gruppo, text: `❓ Mi mancano ${domande.length === 1 ? "un'informazione" : `${domande.length} informazioni`}: le ho chieste in privato, appena risposto rifaccio il carosello.` });
      }
      return;
    } catch {
      // Privato bloccato: pulisco e ripiego sul gruppo
      await redis.del(kCoda(chat), kFlussi(chat), kGruppo(chat));
      await tg("sendMessage", {
        chat_id: gruppo,
        text: "Non riesco a scrivervi in privato: aprite la chat con il bot e premete Avvia. Per stavolta chiedo qui, rispondete al mio messaggio.",
      });
    }
  }
}

// Gestisce un messaggio come possibile risposta. true = era una risposta, il chiamante non deve fare altro.
// fileId: immagine del messaggio, se c'è. salvaLogo arriva da fuori per evitare import circolari.
export async function rispondi(
  m: any,
  fileId: string | undefined,
  salvaLogo: (nome: string, fileId: string) => Promise<void>,
): Promise<boolean> {
  const chat: number = m.chat.id;
  const testo: string = (m.text || m.caption || "").trim();
  const d = (await coda(chat))[0];
  if (!d) return false;
  if (v3(chat)) return rispondiV3(m, d, fileId, salvaLogo);
  // Nel gruppo si chiacchiera: conta solo chi risponde alla domanda del bot
  if (m.chat.type !== "private" && m.reply_to_message?.message_id !== (await redis.get<number>(kMsg(chat)))) return false;

  const salta = /^\/salta(@\w+)?$/i.test(testo);
  if (!salta && testo.startsWith("/")) return false; // altri comandi: non sono risposte
  let extra: Domanda | null = null;

  const reply = (text: string) =>
    tg("sendMessage", { chat_id: chat, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });

  if (!salta) {
    if (d.tipo === "risultato") {
      const r = testo.match(/^(\d{1,3})\s*[-–:]\s*(\d{1,3})$/);
      if (!r || fileId) {
        await reply(`Scrivimi il risultato di ${d.nome} come 3-1 (o /salta).`);
        return true;
      }
      await redis.set(kRisultatoManuale(d.id), { pc: Number(r[1]), po: Number(r[2]) }, { ex: 60 * 86_400 });
      await reply(`✅ ${d.nome}: ${r[1]}-${r[2]}`);
    } else if (d.tipo === "logo") {
      if (!fileId) {
        await reply(`Mi serve l'immagine del logo di ${d.nome} (o /salta).`);
        return true;
      }
      await salvaLogo(d.nome, fileId);
      await reply(`✅ Logo salvato per ${d.nome}`);
    } else {
      const corto = testo.toUpperCase();
      if (!corto || fileId) {
        await reply(`Scrivimi il nome corto per "${d.nome}" (o /salta).`);
        return true;
      }
      if (corto.length > MAX_NOME) {
        await reply(`"${corto}" è lungo ${corto.length} lettere, il massimo è ${MAX_NOME}. Riprova.`);
        return true;
      }
      await setAlias(d.nome, corto);
      await reply(`✅ ${d.nome} → ${corto}`);
      extra = await logoDopoAlias(d, corto);
    }
    await redis.incr(kRisposte(chat));
    if (m.from?.id) await setReferente(m.from.id);
  }

  await redis.lpop(kCoda(chat));
  await metteSubito(chat, extra);
  if (await invia(chat)) return true;

  // Coda finita: rifaccio i caroselli che avevano domande aperte, se almeno una risposta è arrivata
  const flussi = (await redis.hgetall<Record<string, number>>(kFlussi(chat))) || {};
  const gruppo = await redis.get<number>(kGruppo(chat));
  const risposte = Number((await redis.get(kRisposte(chat))) || 0);
  await redis.del(kFlussi(chat), kGruppo(chat), kRisposte(chat), kMsg(chat));
  if (!gruppo || !risposte) {
    await reply("Ok, nient'altro da chiedere.");
    return true;
  }
  await reply("Tutto qui, grazie! Rifaccio il carosello nel gruppo ⏳");
  // Import dinamici: settimana/carosello importano questo file.
  // Sempre nell'argomento 🤖 Automatici: la risposta può arrivare dal privato, che non ha argomenti
  waitUntil(
    nellArgomento("automatici", async () => {
      if (flussi.settimana) await (await import("./settimana")).generaSettimana(gruppo, Number(flussi.settimana), undefined, undefined, false);
      if (flussi.carosello) await (await import("./carosello")).generaCarosello(gruppo, Number(flussi.carosello), undefined, undefined, false);
    }),
  );
  return true;
}

// ---- 3.0 (2026-10-25): domande nell'argomento del post, mai in privato ----
// Un messaggio con l'elenco e l'avanzamento (si aggiorna da solo, con ⏭ Salta tutte) e una domanda alla volta in un
// messaggio suo: la risposta vale per quel messaggio, quindi per quella squadra. Dopo 3 ore senza risposte il bot
// salta quello che manca e rifà il carosello (avviso un'ora prima). A coda finita il carosello si rifà sempre.
type Voce = { d: Domanda; stato: "attesa" | "fatto" | "saltato" };
const kTutte = (chat: number) => `domande:tutte:${chat}`;
const kElenco = (chat: number) => `domande:elenco:${chat}`;
const kGiro = (chat: number) => `domande:giro:${chat}`;
const ORE_AVVISO = 2;
const ORE_SCADENZA = 3;

const nelTopic = async <T>(chat: number, fn: () => Promise<T>) => nelThread(await idArgomento("automatici", chat), fn);
const descrivi = (d: Domanda) => (d.tipo === "logo" ? `🛡 Logo di ${d.nome}` : d.tipo === "risultato" ? `⚽ Risultato di ${d.nome}` : `✏️ Nome corto per ${d.nome}`);

async function aggiornaElenco(chat: number, chiuso?: string) {
  const voci = (await redis.get<Voce[]>(kTutte(chat))) || [];
  if (!voci.length) return;
  const fatte = voci.filter((v) => v.stato !== "attesa").length;
  const giro = await redis.get<number>(kGiro(chat));
  const righe = [
    chiuso ?? `❓ Per completare il carosello mi mancano ${voci.length} cose (${fatte} su ${voci.length})`,
    "",
    ...voci.map((v) => `${v.stato === "fatto" ? "✅" : v.stato === "saltato" ? "⏭" : "▫️"} ${descrivi(v.d)}`),
    ...(chiuso ? [] : ["", `Rispondi alla domanda qui sotto. Se tra ${ORE_SCADENZA} ore manca ancora qualcosa, pubblico senza.`]),
  ];
  const tastiera = chiuso ? [] : [[{ text: "⏭ Salta tutte", callback_data: `dsk:${chat}:${giro}` }]];
  const msg = await redis.get<number>(kElenco(chat));
  await nelTopic(chat, async () => {
    if (msg) await tg("editMessageText", { chat_id: chat, message_id: msg, text: righe.join("\n"), reply_markup: { inline_keyboard: tastiera } }).catch(() => {});
    else {
      const m = await tg<{ message_id: number }>("sendMessage", { chat_id: chat, text: righe.join("\n"), reply_markup: { inline_keyboard: tastiera } });
      await redis.set(kElenco(chat), m.message_id, { ex: TTL });
    }
  });
}

async function chiediV3(gruppo: number, domande: Domanda[], flusso: Flusso, giorni: number) {
  const prima = await coda(gruppo);
  const nuove = domande.filter((d) => !prima.some((p) => uguale(p, d)));
  if (nuove.length) await redis.rpush(kCoda(gruppo), ...nuove);
  await redis.hset(kFlussi(gruppo), { [flusso]: giorni });
  await redis.set(kGruppo(gruppo), gruppo, { ex: TTL });
  for (const k of [kCoda(gruppo), kFlussi(gruppo)]) await redis.expire(k, TTL);
  const voci = prima.length ? (await redis.get<Voce[]>(kTutte(gruppo))) || [] : [];
  voci.push(...nuove.map((d): Voce => ({ d, stato: "attesa" })));
  await redis.set(kTutte(gruppo), voci, { ex: TTL });
  if (!prima.length) {
    await redis.del(kElenco(gruppo));
    const giro = await redis.incr(kGiro(gruppo));
    const dest = (fase: string) => `${process.env.BASE_URL}/api/ig-auto?domande=${gruppo}&giro=${giro}&fase=${fase}`;
    await programmaChiamata(dest("avviso"), ORE_AVVISO * 60).catch((e) => console.error("domande avviso", e));
    await programmaChiamata(dest("scadenza"), ORE_SCADENZA * 60).catch((e) => console.error("domande scadenza", e));
  }
  await aggiornaElenco(gruppo);
  if (!prima.length) await invia(gruppo);
}

async function inviaV3(chat: number, d: Domanda, online = true, nonTrovato = false): Promise<boolean> {
  if (online && d.tipo === "logo") {
    const vecchia = await redis.get<number>(kMsg(chat));
    const ricerca = await mandaLogoTrovato(chat, d, true);
    if (ricerca === "cercato") nonTrovato = true;
    if (ricerca === "trovato") {
      if (vecchia) await tg("deleteMessage", { chat_id: chat, message_id: vecchia }).catch(() => {});
      return true;
    }
  }
  const text =
    d.tipo === "risultato"
      ? `⚽ Risultato di ${d.nome}: rispondi a questo messaggio con il punteggio, es. 3-1 (prima la squadra di casa).\n/salta per lasciare fuori la partita.`
      : d.tipo === "logo"
        ? nonTrovato
          ? `🔎 Non ho trovato online il logo di ${d.nome}: mandalo tu.\nRispondi a questo messaggio con l'immagine, meglio come file PNG.\n/salta per lasciare il nome.`
          : `🛡 Logo di ${d.nome}: rispondi a questo messaggio con l'immagine, meglio come file PNG.\n/salta per lasciare il nome.`
        : `✏️ "${d.nome}" è troppo lungo per la grafica: rispondi a questo messaggio con il nome corto (max ${MAX_NOME} lettere).\n/salta per lasciare fuori la partita.`;
  const vecchia = await redis.get<number>(kMsg(chat));
  if (vecchia) await tg("deleteMessage", { chat_id: chat, message_id: vecchia }).catch(() => {});
  const m = await nelTopic(chat, () => tg<{ message_id: number }>("sendMessage", { chat_id: chat, text, reply_markup: { inline_keyboard: [SALTA(chat)] } }));
  await redis.set(kMsg(chat), m.message_id, { ex: TTL });
  return true;
}

// ⏭ Salta questa (dsq:<chat>) sulla domanda aperta (l'admin 2026-11-03: /salta valeva solo in risposta al messaggio,
// e scritto nell'argomento senza rispondere non succedeva niente). Stessa strada di una risposta /salta
const SALTA = (chat: number) => [{ text: "⏭ Salta questa", callback_data: `dsq:${chat}` }];
export async function suSaltaQuesta(q: any) {
  const chat = Number(String(q.data).split(":")[1]);
  const aperta = await redis.get<number>(kMsg(chat));
  if (!(await coda(chat)).length || aperta !== q.message.message_id || q.message.chat.id !== chat) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Questa domanda è già chiusa." });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: "⏭ Saltata" });
  await tg("editMessageReplyMarkup", { chat_id: chat, message_id: aperta, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  const finta = { chat: q.message.chat, message_id: aperta, text: "/salta", reply_to_message: { message_id: aperta }, from: q.from };
  await rispondi(finta, undefined, async () => {});
}

async function segna(chat: number, d: Domanda, stato: Voce["stato"]) {
  const voci = (await redis.get<Voce[]>(kTutte(chat))) || [];
  const v = voci.find((x) => x.stato === "attesa" && uguale(x.d, d));
  if (v) v.stato = stato;
  await redis.set(kTutte(chat), voci, { ex: TTL });
}

async function rispondiV3(m: any, d: Domanda, fileId: string | undefined, salvaLogo: (nome: string, fileId: string) => Promise<void>): Promise<boolean> {
  const chat: number = m.chat.id;
  // Vale solo la risposta al messaggio della domanda aperta
  if (m.reply_to_message?.message_id !== (await redis.get<number>(kMsg(chat)))) return false;
  const testo: string = (m.text || m.caption || "").trim();
  const salta = /^\/salta(@\w+)?$/i.test(testo);
  if (!salta && testo.startsWith("/")) return false;
  let extra: Domanda | null = null;
  const reply = (text: string) => nelTopic(chat, () => tg("sendMessage", { chat_id: chat, text, reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }));
  if (!salta) {
    if (d.tipo === "risultato") {
      const r = testo.match(/^(\d{1,3})\s*[-–:]\s*(\d{1,3})$/);
      if (!r || fileId) {
        await reply(`Scrivimi il risultato di ${d.nome} come 3-1 (o /salta).`);
        return true;
      }
      await redis.set(kRisultatoManuale(d.id), { pc: Number(r[1]), po: Number(r[2]) }, { ex: 60 * 86_400 });
    } else if (d.tipo === "logo") {
      if (!fileId) {
        await reply(`Mi serve l'immagine del logo di ${d.nome} (o /salta).`);
        return true;
      }
      await salvaLogo(d.nome, fileId);
    } else {
      const corto = testo.toUpperCase();
      if (!corto || fileId) {
        await reply(`Scrivimi il nome corto per "${d.nome}" (o /salta).`);
        return true;
      }
      if (corto.length > MAX_NOME) {
        await reply(`"${corto}" è lungo ${corto.length} lettere, il massimo è ${MAX_NOME}. Riprova.`);
        return true;
      }
      await setAlias(d.nome, corto);
      extra = await logoDopoAlias(d, corto);
    }
    await redis.incr(kRisposte(chat));
  }
  // L'elenco segna ✅ o ⏭, la domanda successiva prende il posto della vecchia
  await tg("setMessageReaction", { chat_id: chat, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] }).catch(() => {});
  await segna(chat, d, salta ? "saltato" : "fatto");
  await redis.lpop(kCoda(chat));
  if (extra) {
    await metteSubito(chat, extra);
    const voci = (await redis.get<Voce[]>(kTutte(chat))) || [];
    const i = voci.findIndex((v) => v.stato === "attesa");
    voci.splice(i < 0 ? voci.length : i, 0, { d: extra, stato: "attesa" });
    await redis.set(kTutte(chat), voci, { ex: TTL });
  }
  await aggiornaElenco(chat);
  if (await invia(chat)) return true;
  const vecchia = await redis.get<number>(kMsg(chat));
  if (vecchia) await tg("deleteMessage", { chat_id: chat, message_id: vecchia }).catch(() => {});
  await chiudiERifai(chat, "✅ Fatto: rifaccio il carosello con le risposte ⏳");
  return true;
}

// Fine delle domande (tutte risposte, ⏭ Salta tutte o 3 ore passate): si rifà sempre il carosello, che poi va
// in coda da solo dopo 30 minuti come gli automatici
async function chiudiERifai(chat: number, titolo: string) {
  const flussi = (await redis.hgetall<Record<string, number>>(kFlussi(chat))) || {};
  const gruppo = (await redis.get<number>(kGruppo(chat))) ?? chat;
  await aggiornaElenco(chat, titolo);
  await redis.del(kCoda(chat), kFlussi(chat), kGruppo(chat), kRisposte(chat), kMsg(chat), kTutte(chat), kElenco(chat));
  await redis.incr(kGiro(chat)); // i timer di questo giro non valgono più
  waitUntil(
    nelTopic(gruppo, async () => {
      if (flussi.settimana) await (await import("./settimana")).generaSettimana(gruppo, Number(flussi.settimana), undefined, undefined, false);
      if (flussi.carosello) await (await import("./carosello")).generaCarosello(gruppo, Number(flussi.carosello), undefined, undefined, false);
    }),
  );
}

async function saltaTutte(chat: number, titolo: string) {
  if (!(await coda(chat)).length) return false;
  const voci = (await redis.get<Voce[]>(kTutte(chat))) || [];
  for (const v of voci) if (v.stato === "attesa") v.stato = "saltato";
  await redis.set(kTutte(chat), voci, { ex: TTL });
  const vecchia = await redis.get<number>(kMsg(chat));
  if (vecchia) await tg("deleteMessage", { chat_id: chat, message_id: vecchia }).catch(() => {});
  await chiudiERifai(chat, titolo);
  return true;
}

// ⏭ Salta tutte (dsk:<chat>:<giro>)
export async function suSaltaTutte(q: any) {
  const [, chat, giro] = String(q.data).split(":");
  const ok =
    Number(giro) === Number(await redis.get(kGiro(Number(chat)))) &&
    (await saltaTutte(Number(chat), `⏭ Saltate da ${q.from?.first_name || "qualcuno"}: rifaccio il carosello con quello che c'è ⏳`));
  if (ok) await conta("domande_saltate", chat);
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: ok ? "Rifaccio il carosello" : "Domande già chiuse." });
}

// QStash (api/ig-auto?domande=<chat>&giro=<n>&fase=avviso|scadenza)
export async function scadenzaDomande(chat: number, giro: number, fase: string | null) {
  if (giro !== Number(await redis.get(kGiro(chat))) || !(await coda(chat)).length) return;
  if (fase === "avviso") {
    await nelTopic(chat, () => tg("sendMessage", { chat_id: chat, text: "⏰ Tra un'ora pubblico il carosello senza le cose che mancano ancora." })).catch(() => {});
    return;
  }
  const mancano = (await coda(chat)).map(descrivi);
  await conta("domande_scadute", chat);
  await saltaTutte(chat, `⏰ Passate ${ORE_SCADENZA} ore: rifaccio il carosello con quello che c'è ⏳`);
  const errori = await idArgomento("errori", chat);
  await nelThread(errori, () => tg("sendMessage", { chat_id: chat, text: `⚠️ Carosello uscito senza:\n${mancano.join("\n")}` })).catch(() => {});
}
