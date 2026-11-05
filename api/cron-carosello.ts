import { nellArgomento } from "../lib/argomenti";
import { aggiornaPartite, generaCarosello } from "../lib/carosello";
import { firmaQstash } from "../lib/qstash";

// Carosello della settimana nel gruppo, martedì alle 9:00 ora italiana. Dal 2026-10-14 la chiama una pianificazione
// QStash con fuso Europe/Rome (api/setup?pianifica=1), non più il cron di Vercel: quello è solo in UTC (col cambio
// dell'ora usciva un'ora prima) e sul piano Hobby parte in un momento qualsiasi dentro l'ora.
// GET con "Authorization: Bearer CRON_SECRET" resta per un lancio a mano.
async function esegui() {
  // Il gruppo è l'unico ID negativo in ALLOWED_CHAT_IDS (gli ID privati sono positivi)
  const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
  if (!gruppo) return new Response("nessun gruppo in ALLOWED_CHAT_IDS", { status: 500 });

  // Da mercoledì a martedì: 6 giorni indietro, così la settimana prima non si ripete
  await nellArgomento("automatici", () => generaCarosello(Number(gruppo), 6));
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
  // ?prova=1: legge solo i portali e risponde con il conteggio, niente Canva né Telegram
  if (new URL(req.url).searchParams.get("prova")) return Response.json(await aggiornaPartite());
  return esegui();
}
