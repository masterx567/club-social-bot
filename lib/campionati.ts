import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { SPORT, etichetta, riconosci } from "./categorie";
import { redis } from "./store";
import { tg } from "./telegram";
import { nellArgomento } from "./argomenti";

// Campionati nuovi sul portale (2026-10-21): il bot capisce sport e categoria dal nome e chiede all'admin
// in privato con un bottone. ✅ salva nell'hash "campionati" (letto da categoriaDi) e rifà la grafica che li ha
// trovati. Niente più modifiche a mano in lib/partite.ts. Ogni campionato si chiede una volta sola.

interface Proposta {
  chiave: string; // ente:campionato
  nome: string;
  opzioni: [string, string][]; // [sport, categoria]
  gruppo: number;
  flusso: "settimana" | "carosello";
  giorni: number;
}
const TTL = 14 * 86_400;
const corto = (k: string) => crypto.createHash("sha1").update(k).digest("hex").slice(0, 10);

// Possibili categorie dal nome del campionato: prima riconosci(), poi "U16" -> UNDER 16 in ogni sport che l'ha
export function opzioni(nome: string, ente: string): [string, string][] {
  const testo = nome.replace(/\bU\s?(\d{1,2})/gi, "under $1").replace(/\bF\b/g, "femminile");
  const r = riconosci(ente === "FIP" || ente === "UISP" ? `basket ${testo}` : testo);
  if (r.sport && r.categoria) return [[r.sport, r.categoria]];
  const n = testo.match(/under\s*(\d{1,2})/i)?.[1];
  if (!n) return [];
  return Object.entries(SPORT).flatMap(([s, cs]) => cs.filter((c) => c.startsWith(`UNDER ${n}`)).map((c) => [s, c] as [string, string]));
}

// voci: "ente:campionato|nome campionato"
export async function proponiCampionati(voci: string[], gruppo: number, flusso: Proposta["flusso"], giorni: number) {
  const admin = process.env.ADMIN_CHAT_ID;
  if (!admin) return;
  for (const v of voci) {
    const [chiave, nome = ""] = v.split("|");
    if (!(await redis.set(`campionati:chiesto:${chiave}`, 1, { nx: true, ex: TTL }))) continue; // già chiesto
    const ops = opzioni(nome, chiave.split(":")[0]);
    const id = corto(chiave);
    await redis.set<Proposta>(`campionati:proposta:${id}`, { chiave, nome, opzioni: ops, gruppo, flusso, giorni }, { ex: TTL });
    const bottoni = [
      ...ops.map(([s, c], i) => [{ text: `✅ ${etichetta(s, c)}`, callback_data: `cmp:${id}:${i}` }]),
      [{ text: "❌ Lascia fuori", callback_data: `cmp:${id}:x` }],
    ];
    await tg("sendMessage", {
      chat_id: admin,
      text: ops.length
        ? `🗂 Campionato nuovo sul portale:\n${chiave.split(":")[0]} «${nome}»\n\nLo aggiungo come categoria qui sotto? Le sue partite entrano nelle grafiche.`
        : `🗂 Campionato nuovo sul portale:\n${chiave.split(":")[0]} «${nome}»\n\nNon riesco a capire la categoria dal nome: per ora le sue partite restano fuori.`,
      reply_markup: { inline_keyboard: bottoni },
    }).catch(() => {});
  }
}

export async function suCampionato(q: any) {
  const [, id, scelta] = String(q.data).split(":");
  const p = await redis.get<Proposta>(`campionati:proposta:${id}`);
  const fine = (text: string) =>
    tg("editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text }).catch(() => {});
  if (!p) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Proposta scaduta.", show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id });
  await redis.del(`campionati:proposta:${id}`);
  if (scelta === "x") {
    await fine(`❌ «${p.nome}» resta fuori dalle grafiche.`);
    return;
  }
  const [sport, categoria] = p.opzioni[Number(scelta)];
  await redis.hset("campionati", { [p.chiave]: [sport, categoria] });
  await fine(`✅ «${p.nome}» aggiunto come ${etichetta(sport, categoria)}. Rifaccio la grafica nel gruppo ⏳`);
  waitUntil(
    nellArgomento("automatici", async () => {
      if (p.flusso === "settimana") await (await import("./settimana")).generaSettimana(p.gruppo, p.giorni, undefined, undefined, false);
      else await (await import("./carosello")).generaCarosello(p.gruppo, p.giorni, undefined, undefined, false);
    }),
  );
}
