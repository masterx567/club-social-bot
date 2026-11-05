import { nellArgomento } from "../lib/argomenti";
import { firmaQstash } from "../lib/qstash";
import { generaSettimana } from "../lib/settimana";

// Partite da giovedì a mercoledì, da pubblicare il giovedì: mercoledì alle 19:00 ora italiana. Dal 2026-10-14 la chiama
// una pianificazione QStash con fuso Europe/Rome (api/setup?pianifica=1), non più il cron di Vercel: quello è solo in
// UTC (col cambio dell'ora usciva un'ora prima) e sul piano Hobby parte in un momento qualsiasi dentro l'ora.
// GET con "Authorization: Bearer CRON_SECRET" resta per un lancio a mano.
async function esegui() {
  // Il gruppo è l'unico ID negativo in ALLOWED_CHAT_IDS (gli ID privati sono positivi)
  const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
  if (!gruppo) return new Response("nessun gruppo in ALLOWED_CHAT_IDS", { status: 500 });

  await nellArgomento("automatici", () => generaSettimana(Number(gruppo), 7));
  return new Response("ok");
}

export async function POST(req: Request) {
  if (!firmaQstash(req.headers.get("upstash-signature"), await req.text())) return new Response("forbidden", { status: 403 });
  return esegui();
}

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  return esegui();
}
