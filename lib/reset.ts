import { NOMI, idArgomento } from "./argomenti";
import { inProva } from "./prova";
import { programmaChiamata } from "./qstash";
import { redis } from "./store";
import { K_GENERALE, kManuali, tg } from "./telegram";

// Pulizia di ✍️ Post manuali (e del Generale nel gruppo vero). Usata da /reset e, nella 3.0, in automatico a coda finita.
// Dal 2026-10-28 l'argomento NON si cancella più: ricreato perdeva il fissato in cima e i bot non possono fissarlo.
// Si cancellano i messaggi annotati man mano (kManuali, lib/telegram.ts): Telegram lo permette solo per quelli
// delle ultime 48 ore, quanto dura la coda. Se l'argomento non c'è (mai creato) si crea.
// La guida è fissata nel Generale e non si tocca.
export async function pulisciManuali(chatId: number): Promise<{ vecchio?: number; nuovo: number }> {
  const vecchio = await idArgomento("manuali", chatId);
  let nuovo = vecchio;
  if (vecchio) {
    const ids = ((await redis.zrange(kManuali(chatId), Date.now() - 47 * 3600_000, "+inf", { byScore: true })) as string[]).map(Number);
    for (let i = 0; i < ids.length; i += 100) await tg("deleteMessages", { chat_id: chatId, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    await redis.del(kManuali(chatId));
  } else {
    nuovo = (await tg<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name: NOMI.manuali })).message_thread_id;
    await redis.hset(inProva(chatId) ? `argomenti:${chatId}` : "argomenti", { manuali: nuovo });
  }
  // Generale: messaggi annotati delle ultime 48 ore (oltre Telegram non li fa cancellare), tranne la guida fissata.
  // Solo nel gruppo vero: l'elenco dei messaggi del Generale è il suo
  if (!inProva(chatId)) {
    const guida = (await tg<any>("getChat", { chat_id: chatId })).pinned_message?.message_id;
    const ids = ((await redis.zrange(K_GENERALE, Date.now() - 47 * 3600_000, "+inf", { byScore: true })) as string[]).map(Number).filter((id) => id !== guida);
    for (let i = 0; i < ids.length; i += 100) await tg("deleteMessages", { chat_id: chatId, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    await redis.del(K_GENERALE);
  }
  return { vecchio, nuovo: nuovo! };
}

// ---- 3.0: reset automatico (2026-10-25) ----
// Parte quando la coda è finita senza errori, ma solo se non c'è lavoro in corso: post aperti (non pubblicati e non
// scartati), domande in attesa, richieste a metà. Se c'è, riprova da solo ogni 30 minuti (al massimo 12 volte).
const RIPROVA_MIN = 30;
const MAX_TENTATIVI = 12;

async function lavoroInCorso(chatId: number): Promise<string | null> {
  const chiavi = async (match: string) => {
    const out: string[] = [];
    let cur = "0";
    do {
      const [c, k] = await redis.scan(cur, { match, count: 500 });
      cur = String(c);
      out.push(...(k as string[]));
    } while (cur !== "0");
    return out;
  };
  if (await redis.llen(`domande:${chatId}`)) return "domande in attesa";
  if ((await chiavi(`st:${chatId}:*`)).length) return "una richiesta a metà";
  const post = new Set<string>();
  for (const k of await chiavi(`igcover:${chatId}:*`)) {
    const id = await redis.get<string>(k);
    if (id) post.add(id);
  }
  for (const id of post) {
    if ((await redis.exists(`igpost:${id}`)) && !(await redis.exists(`iglock:${id}`))) return "un post ancora aperto";
  }
  return null;
}

export async function resetSePossibile(chatId: number, tentativo = 1): Promise<string> {
  const motivo = await lavoroInCorso(chatId);
  if (motivo) {
    if (tentativo < MAX_TENTATIVI) {
      await programmaChiamata(`${process.env.BASE_URL}/api/ig-auto?reset=${chatId}&n=${tentativo + 1}`, RIPROVA_MIN).catch((e) => console.error("reset", e));
    }
    return `rimandato: ${motivo}`;
  }
  await pulisciManuali(chatId);
  return "fatto";
}

// 3.0: il menu sulla foto (🏆 Risultato, 📷 Post foto, ✖️ Niente) sparisce da solo dopo 10 minuti senza scelta
// (2026-10-27). QStash chiama api/ig-auto?menu=<chat>&utente=<id>&msg=<menu>: se la richiesta è ancora
// ferma su quel menu si cancellano messaggio e richiesta; se nel frattempo si è scelto, non si tocca niente.
export const MENU_MIN = 10;
export const programmaChiusuraMenu = (chatId: number, utente: number, msg: number) =>
  programmaChiamata(`${process.env.BASE_URL}/api/ig-auto?menu=${chatId}&utente=${utente}&msg=${msg}`, MENU_MIN);

export async function chiudiMenu(chatId: number, utente: number, msg: number) {
  const { getStato, delStato } = await import("./store");
  const st = await getStato(chatId, utente);
  if (st?.step !== "menu" || st.promptMsgId !== msg) return;
  const { conta } = await import("./eventi");
  await conta("menu_scaduto", chatId);
  await delStato(chatId, utente);
  await tg("deleteMessage", { chat_id: chatId, message_id: msg }).catch(() => {});
}
