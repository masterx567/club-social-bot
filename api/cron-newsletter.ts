import { nellArgomento } from "../lib/argomenti";
import { anteprima } from "../lib/newsletter";
import { firmaQstash } from "../lib/qstash";
import { avvisaAdmin } from "../lib/telegram";

// Anteprima newsletter nel topic 📰 RSS CSI, venerdì alle 10:30 ora italiana (3.0, prima 10:00); l'invio parte 90 minuti dopo (12:00).
// Dal 2026-10-13 la chiama una pianificazione QStash con fuso Europe/Rome (api/setup?pianifica=1), non più il cron
// di Vercel: quello è solo in UTC (l'ora cambierebbe col cambio dell'ora) e sul piano Hobby parte in un momento
// qualsiasi dentro l'ora. GET con CRON_SECRET resta per un lancio a mano.
async function esegui() {
  const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
  if (!gruppo) return new Response("nessun gruppo", { status: 500 });
  try {
    const n = await nellArgomento("csi", () => anteprima(Number(gruppo)));
    return new Response(`ok, ${n} news`);
  } catch (e) {
    console.error("cron newsletter", e);
    await avvisaAdmin(`Anteprima newsletter fallita: ${(e as Error).message}`);
    return new Response("errore", { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!firmaQstash(req.headers.get("upstash-signature"), await req.text())) return new Response("forbidden", { status: 403 });
  return esegui();
}

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("forbidden", { status: 403 });
  return esegui();
}
