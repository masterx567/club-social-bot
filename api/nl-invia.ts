import { invioProgrammato } from "../lib/newsletter";
import { firmaQstash } from "../lib/qstash";

// QStash chiama qui un'ora dopo l'anteprima del venerdì (lib/newsletter.ts). Solo chiamate firmate.
export async function POST(req: Request) {
  const body = await req.text();
  if (!firmaQstash(req.headers.get("upstash-signature"), body)) return new Response("forbidden", { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (id) await invioProgrammato(id);
  return new Response("ok");
}
