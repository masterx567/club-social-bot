import { collega, immagine, linkLogin } from "../lib/instagram";

const testo = (t: string, status = 200) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// Un solo endpoint per tre cose (Hobby ha un tetto di funzioni):
//   ?img=id:n     immagine JPEG che Instagram scarica per pubblicare
//   ?code=&state= ritorno dal login Instagram
//   ?key=SETUP    avvio login, protetto da SETUP_SECRET
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;

  const img = p.get("img");
  if (img) {
    const b = await immagine(img);
    return b ? new Response(new Uint8Array(b), { headers: { "Content-Type": "image/jpeg" } }) : testo("non trovata", 404);
  }

  if (p.get("error")) return testo(`Login annullato: ${p.get("error_description") || p.get("error")}`, 400);
  const code = p.get("code");
  if (code) {
    try {
      return testo(`✅ Collegato: ${await collega(code, p.get("state") || "")}. Puoi chiudere questa pagina.`);
    } catch (e) {
      return testo(`Login non riuscito: ${(e as Error).message}`, 400);
    }
  }

  if (p.get("key") !== process.env.SETUP_SECRET) return testo("forbidden", 403);
  return Response.redirect(await linkLogin(), 302);
}
