import { fasciaPersone } from "../lib/soggetti";
import { ritaglia } from "../lib/crop";
import { controllaPost } from "../lib/controlli";
import { scriviBozza } from "../lib/bozza";

// Debug ritaglio sul server (dove c'è GROQ_API_KEY): POST dell'immagine grezza,
// risponde con il JPEG ritagliato e la fascia trovata nell'header X-Fascia.
// curl --data-binary @foto.jpg "<BASE_URL>/api/prova-crop?key=<SETUP_SECRET>" -o out.jpg -D -
export async function POST(req: Request) {
  if (new URL(req.url).searchParams.get("key") !== process.env.SETUP_SECRET) return new Response("forbidden", { status: 403 });
  // ?bozza=1: il corpo è lo spunto, risponde con la bozza AI della didascalia (2.0)
  if (new URL(req.url).searchParams.get("bozza")) return new Response((await scriviBozza(await req.text())) ?? "NULL");
  // ?cerca=<nome corto>&lungo=<nome portale>: ricerca online del logo (lib/cercalogo.ts, 2026-10-29), risponde con
  // ogni immagine controllata e la sua classificazione. Non salva nulla.
  const q = new URL(req.url).searchParams;
  // ?domandeprova=1, corpo JSON [{nome, lungo}]: apre in gruppo di prova le domande sui loghi (prova della ricerca online
  // nel gruppo, 2026-10-29). Solo il gruppo di prova; un ✅ salva il logo vero come una risposta con l'immagine.
  if (q.get("domandeprova")) {
    const { chiedi } = await import("../lib/domande");
    const { CHAT_PROVA } = await import("../lib/prova");
    const lista = (await req.json()) as { nome: string; lungo?: string }[];
    await chiedi(CHAT_PROVA, lista.map((x) => ({ tipo: "logo" as const, nome: String(x.nome).toUpperCase(), lungo: x.lungo })), "settimana", 7);
    return new Response("ok");
  }
  if (q.get("cerca")) {
    const { cercaEClassifica } = await import("../lib/cercalogo");
    return Response.json(await cercaEClassifica(q.get("cerca")!, q.get("lungo") || undefined));
  }
  const img = Buffer.from(await req.arrayBuffer());
  // ?logo=<nome>&lungo=<nome portale>: classificazione dell'immagine nel corpo
  if (q.get("logo")) {
    const { classificaLogo } = await import("../lib/cercalogo");
    return Response.json(await classificaLogo(img, q.get("logo")!, q.get("lungo") || undefined));
  }
  // ?controllo=1: risponde con i problemi trovati dal controllo AI prima della pubblicazione (2026-10-18)
  if (new URL(req.url).searchParams.get("controllo")) return Response.json(await controllaPost([img], ""));
  const t0 = Date.now();
  const fascia = await fasciaPersone(img);
  const ms = Date.now() - t0;
  const out = await ritaglia(img);
  return new Response(new Uint8Array(out), {
    headers: { "Content-Type": "image/jpeg", "X-Fascia": JSON.stringify(fascia), "X-Groq-Ms": String(ms) },
  });
}
