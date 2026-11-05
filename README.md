# club-social-bot

> **EN** — Telegram bot that runs the social media of an amateur sports club. Coaches send a photo and a score in a Telegram group; the bot pulls fixtures from league portals (CSI, UISP, FIP), builds the graphic in Canva, writes the caption with an LLM, and publishes to Instagram and Facebook through a queue. It also posts weekly results carousels, league news, monthly stats and a newsletter. Stack: TypeScript on Vercel, Upstash Redis + QStash, Canva Connect API, Meta Graph API, Groq, Brevo. Showcase repo: code is in Italian and tied to one real club, not a ready-to-install package. MIT licensed.

Bot Telegram che gestisce i social di una società sportiva dilettantistica (nel codice: **SS Cormano**, nome di fantasia per una società reale di Cormano).

## Cosa fa

- **Risultati:** l'allenatore manda foto + `/risultato` nel gruppo; il bot propone le partite recenti prese dai portali (CSI Milano, UISP, FIP), chiede il punteggio, genera la grafica da template Canva.
- **Didascalie:** scritte da un LLM (Groq) con esempi presi dai post veri; titolo, punteggio e hashtag li mette il codice dai dati ufficiali.
- **Pubblicazione:** coda unica verso Instagram e Facebook (Meta Graph API), con approvazione ✅ nel gruppo.
- **Carosello settimanale:** risultati della settimana in un carosello, chiede i risultati mancanti.
- **Notizie e statistiche:** news CSI nel gruppo, report mensile/trimestrale con "cosa tira".
- **Newsletter** del venerdì via Brevo.
- **Release disciplinate:** `npm run release` controlla la voce di registro, fa typecheck, deploy, verifica, tag e push. I deploy diretti sono bloccati.

## Stack

TypeScript · Vercel Functions + Cron · Upstash Redis e QStash · Canva Connect API · Meta Graph API · Groq · Brevo · Bot API Telegram via `fetch`, senza framework.

## Struttura

- `api/` handler Vercel (webhook Telegram, cron, login Canva/Instagram)
- `lib/` logica: `pipeline.ts`, `carosello.ts`, `bozza.ts` (didascalie), `fonti/` (portali), `instagram.ts`, `newsletter.ts`
- `scripts/release.ts` procedura di release
- `docs/manuale.md` manuale tecnico completo

## Stato

Repo **vetrina**: snapshot del bot in produzione, con nomi, ID e template sostituiti. Per farlo girare servono account propri (Telegram, Canva, Meta, Upstash, Groq, Brevo) e template Canva propri: vedi `.env.example` e il manuale. Se vuoi usarlo per la tua società, apri una issue.

## Licenza

MIT
