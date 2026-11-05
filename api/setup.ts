import { readFileSync } from "fs";
import { join } from "path";
import { NOMI, nellArgomento } from "../lib/argomenti";
import { anteprima } from "../lib/newsletter";
import { redis } from "../lib/store";
import { generaSettimana } from "../lib/settimana";
import { tg } from "../lib/telegram";
import { SPONSOR } from "../lib/metriche";

// Registra il webhook Telegram e mostra lo stato. Da aprire una volta dopo il deploy.
export async function GET(req: Request) {
  const url = new URL(req.url);
  // ?logo=1: logo pubblico per la newsletter (le mail caricano le immagini da un URL). Qui e non in una funzione
  // a parte: il piano Hobby di Vercel ammette massimo 12 funzioni
  if (url.searchParams.get("logo")) {
    const png = readFileSync(join(process.cwd(), "docs/logo-mail.png"));
    return new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  }
  // ?vai=<sponsor>: link dal sito agli sponsor (2026-10-19). Conta il click per giorno e apre il sito dello sponsor
  // con l'etichetta utm, così anche lo sponsor vede nelle sue statistiche le visite arrivate da SS Cormano.
  const vai = url.searchParams.get("vai");
  if (vai) {
    const dest = SPONSOR[vai];
    if (!dest) return Response.redirect("https://www.example.org/", 302);
    const giorno = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    await redis.hincrby(`sponsor:click:${vai}`, giorno, 1).catch(() => {});
    const u = new URL(dest);
    u.searchParams.set("utm_source", "club-social-bot");
    u.searchParams.set("utm_medium", "sponsor");
    u.searchParams.set("utm_campaign", "linea-verde-2026-27");
    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
  }
  if (url.searchParams.get("key") !== process.env.SETUP_SECRET) return new Response("forbidden", { status: 403 });

  // ?argomenti=1: crea nel gruppo gli argomenti che mancano e rinomina quelli esistenti come in NOMI
  // (serve il bot admin con "Gestisci argomenti"). I nomi seguono il codice: cambiarli = release.
  if (url.searchParams.get("argomenti")) {
    const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
    const fatti: Record<string, number | string> = {};
    for (const [chiave, nome] of Object.entries(NOMI)) {
      const esistente = await redis.hget<number>("argomenti", chiave);
      if (esistente) {
        // Telegram rifiuta un nome uguale a quello attuale (TOPIC_NOT_MODIFIED): non è un errore
        fatti[chiave] = await tg("editForumTopic", { chat_id: gruppo, message_thread_id: esistente, name: nome })
          .then(() => `${esistente}: ${nome}`)
          .catch((e) => (/not.?modified/i.test((e as Error).message) ? `${esistente}: ${nome} (già così)` : `${esistente}: errore ${(e as Error).message}`));
        continue;
      }
      try {
        const t = await tg<{ message_thread_id: number }>("createForumTopic", { chat_id: gruppo, name: nome });
        await redis.hset("argomenti", { [chiave]: t.message_thread_id });
        fatti[chiave] = t.message_thread_id;
      } catch (e) {
        fatti[chiave] = `errore: ${(e as Error).message}`;
      }
    }
    return Response.json({ gruppo, argomenti: fatti });
  }

  // ?pianifica=1: crea o aggiorna (stesso id) le pianificazioni QStash, in ora italiana tutto l'anno (CRON_TZ),
  // e mostra quelle attive. Gli orari stanno qui nel codice: cambiarli = release.
  // Carosello e settimana senza nuovi tentativi: un tentativo ripetuto manderebbe l'album due volte nel gruppo.
  if (url.searchParams.get("pianifica")) {
    const base = process.env.QSTASH_URL || "https://qstash.upstash.io";
    const auth = { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` };
    const PIANO = [
      { id: "newsletter-venerdi", verso: "cron-newsletter", cron: "30 10 * * 5", tentativi: 2 }, // 3.0: anteprima 10:30, invio 12:00
      { id: "carosello-martedi", verso: "cron-carosello", cron: "0 9 * * 2", tentativi: 0 },
      { id: "settimana-mercoledi", verso: "cron-settimana", cron: "0 19 * * 3", tentativi: 0 },
      // 3.0: risultati della settimana senza post, prima del carosello di martedì (2026-10-28)
      // Va su ig-auto con l'intestazione Promemoria: niente funzione nuova (il piano Hobby ne ammette 12) e niente "?"
      // nell'indirizzo, che le pianificazioni non accettano
      { id: "promemoria-lunedi", verso: "ig-auto", cron: "0 20 * * 1", tentativi: 0, inoltra: { Promemoria: "1" } },
    ] as { id: string; verso: string; cron: string; tentativi: number; inoltra?: Record<string, string> }[];
    const fatte: Record<string, unknown> = {};
    for (const p of PIANO) {
      const r = await fetch(`${base}/v2/schedules/${process.env.BASE_URL}/api/${p.verso}`, {
        method: "POST",
        headers: {
          ...auth,
          "Upstash-Cron": `CRON_TZ=Europe/Rome ${p.cron}`,
          "Upstash-Schedule-Id": p.id,
          "Upstash-Retries": String(p.tentativi),
          ...Object.fromEntries(Object.entries(p.inoltra || {}).map(([k, v]) => [`Upstash-Forward-${k}`, v])),
        },
      });
      fatte[p.id] = r.ok ? await r.json() : { errore: `${r.status} ${await r.text()}` };
    }
    const tutte: any[] = await (await fetch(`${base}/v2/schedules`, { headers: auth })).json();
    return Response.json({
      fatte,
      pianificazioni: tutte.map((s) => ({ id: s.scheduleId, cron: s.cron, verso: String(s.destination).replace(process.env.BASE_URL || "", ""), tentativi: s.retries, sospesa: s.isPaused ?? false })),
    });
  }

  // ?brevo=1: liste, mittenti e domini Brevo (per configurare la newsletter, nessun segreto in uscita)
  if (url.searchParams.get("brevo")) {
    const b = async (p: string) => (await fetch(`https://api.brevo.com/v3/${p}`, { headers: { "api-key": process.env.BREVO_API_KEY || "" } })).json();
    // ?brevo=log: ultimi eventi delle mail transazionali (test newsletter): consegnata, spam, bloccata...
    if (url.searchParams.get("brevo") === "log") {
      const ev: any = await b("smtp/statistics/events?limit=20&days=2");
      return Response.json(ev.events?.map((e: any) => ({ quando: e.date, evento: e.event, oggetto: e.subject, motivo: e.reason })) ?? ev);
    }
    const liste: any = await b("contacts/lists?limit=50");
    const mittenti: any = await b("senders");
    const domini: any = await b("senders/domains");
    return Response.json({
      liste: liste.lists?.map((l: any) => ({ id: l.id, nome: l.name, contatti: l.uniqueSubscribers ?? l.totalSubscribers })) ?? liste,
      mittenti: mittenti.senders?.map((s: any) => ({ nome: s.name, email: s.email, attivo: s.active })) ?? mittenti,
      domini: domini.domains?.map((d: any) => ({ dominio: d.domain_name, autenticato: d.authenticated, verificato: d.verified })) ?? domini,
      // Modalità della newsletter, da controllare senza mandare mail: live = liste vere, altrimenti solo prova
      newsletter: process.env.NEWSLETTER_LIVE === "1" ? { live: true, liste: process.env.NEWSLETTER_LISTE || "5,4" } : { live: false, prova: process.env.NEWSLETTER_TEST_EMAIL || "admin" },
    });
  }

  // ?newsletter=1: anteprima newsletter adesso nel topic 📰 RSS CSI, come il cron del venerdì (invio dopo 60 min o col ✅)
  if (url.searchParams.get("newsletter")) {
    const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
    const n = await nellArgomento("csi", () => anteprima(Number(gruppo)));
    return Response.json({ news: n, live: process.env.NEWSLETTER_LIVE === "1" });
  }

  // ?settimana=N: lancia a mano le partite della settimana sul server (dove ci sono Groq e QStash), come il cron
  const giorni = url.searchParams.get("settimana");
  if (giorni) {
    const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
    // Sincrono: chi lancia vede quanto ci mette e se si è rotto qualcosa (generaSettimana avvisa anche l'admin)
    const t0 = Date.now();
    try {
      await nellArgomento("automatici", () => generaSettimana(Number(gruppo), Number(giorni) || 7));
      return Response.json({ ok: true, gruppo, giorni: Number(giorni) || 7, ms: Date.now() - t0 });
    } catch (e) {
      return Response.json({ ok: false, errore: (e as Error).message, ms: Date.now() - t0 }, { status: 500 });
    }
  }

  await tg("setWebhook", {
    url: `${process.env.BASE_URL}/api/telegram`,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await tg("setMyCommands", {
    commands: [
      { command: "risultato", description: "Usalo come didascalia della foto" },
      { command: "amichevole", description: "Come /risultato, con il template amichevole" },
      { command: "newsletter", description: "Anteprima newsletter subito, con le notizie scelte con 📧" },
      { command: "evento", description: "Foto con didascalia: /evento Titolo" },
      { command: "annulla", description: "Annulla la richiesta in corso" },
      { command: "carosello", description: "Risultati degli ultimi 7 giorni" },
      { command: "settimana", description: "Partite dei prossimi 7 giorni" },
      { command: "coda", description: "Post in coda per Instagram e Facebook, con gli orari" },
      { command: "logo", description: "Didascalia del logo avversario: /logo NOME" },
      { command: "metriche", description: "Statistiche Instagram e Facebook (ultimi 30 giorni)" },
    ],
  });
  const info = await tg("getWebhookInfo", {});
  return Response.json({ webhook: info, login_canva: `${process.env.BASE_URL}/api/canva-auth?key=…` });
}
