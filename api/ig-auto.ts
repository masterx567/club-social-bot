import { giraCoda, pubblicaProgrammato, riprovaIg } from "../lib/instagram";
import { firmaQstash } from "../lib/qstash";
import { scadenzaDomande } from "../lib/domande";
import { chiudiMenu, resetSePossibile } from "../lib/reset";
import { promemoriaRisultati } from "../lib/promemoria";
import { v3 } from "../lib/prova";
import { statistichePost } from "../lib/registro";

// QStash chiama qui:
// - ?id=<post>: scaduta la finestra di annullamento di un post automatico → il post va in coda (lib/instagram.ts, programma()).
// - ?soloig=<post>&n=<n>: riprova solo Instagram dopo un'uscita a metà.
// - ?stat=<post>: statistiche del post a 7 giorni, nel registro dei post pubblicati.
// - ?coda=1: giro della coda di pubblicazione, un post ogni 2 ore, mai tra le 23 e le 8 (lib/instagram.ts, giraCoda(), 2026-10-11).
// Sicurezza (2026-10-08): si accetta solo una chiamata firmata da QStash (header Upstash-Signature, JWT HS256
// con le chiavi di firma dell'integrazione Vercel). Prima c'era SETUP_SECRET nell'URL, salvato da Upstash.
export async function POST(req: Request) {
  const body = await req.text();
  if (!firmaQstash(req.headers.get("upstash-signature"), body)) return new Response("forbidden", { status: 403 });
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  if (id) await pubblicaProgrammato(id);
  if (q.get("coda")) await giraCoda();
  // ?soloig=<post>&n=<tentativo>: Facebook uscito, Instagram no → si riprova solo Instagram (2026-10-18)
  const soloIg = q.get("soloig");
  if (soloIg) await riprovaIg(soloIg, Number(q.get("n") || 1));
  // ?domande=<chat>&giro=<n>&fase=avviso|scadenza: 3.0, domande dei caroselli senza risposta dopo 2 e 3 ore (lib/domande.ts)
  const domande = q.get("domande");
  if (domande) await scadenzaDomande(Number(domande), Number(q.get("giro")), q.get("fase"));
  // ?reset=<chat>&n=<tentativo>: 3.0, reset automatico rimandato perché c'era lavoro in corso (lib/reset.ts)
  const reset = q.get("reset");
  if (reset) await resetSePossibile(Number(reset), Number(q.get("n") || 1));
  // ?menu=<chat>&utente=<id>&msg=<menu>: 3.0, menu sulla foto senza scelta dopo 10 minuti (lib/reset.ts)
  const menu = q.get("menu");
  if (menu) await chiudiMenu(Number(menu), Number(q.get("utente")), Number(q.get("msg")));
  // Intestazione Promemoria (pianificazione QStash promemoria-lunedi, lunedì 20:00): 3.0, risultati della settimana senza post
  if (req.headers.get("promemoria")) {
    const gruppo = Number((process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-")));
    if (gruppo && v3(gruppo)) await promemoriaRisultati(gruppo);
  }
  // ?stat=<post>: statistiche del post 7 giorni dopo l'uscita, nel registro (lib/registro.ts, 2026-10-26)
  const stat = q.get("stat");
  if (stat) await statistichePost(stat);
  return new Response("ok");
}
