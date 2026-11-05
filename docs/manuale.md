# Manuale tecnico del bot social SS Cormano

Per chi mantiene il bot: l'admin e le sessioni di Claude. Organizzato per argomento, non per data: la storia delle modifiche sta nel registro delle release. Dati controllati sul codice il 26 ottobre 2026.

Regola: se una release cambia un flusso, un template, un orario o una variabile, cambia anche questo manuale (campo `manuale` della voce).

## 1. Cos'è

Bot Telegram **@tuo_bot** che vive nel gruppo privato dei social del club (forum ad argomenti). Prepara le grafiche sui template Canva del club, le pubblica insieme su Instagram (@account_del_club) e sulla Pagina Facebook, porta nel gruppo le notizie del CSI Milano e le statistiche, prepara la newsletter del venerdì.

Le persone scelgono e approvano; il bot esegue, controlla e avvisa. In produzione dal 30 settembre 2026.

## 2. Architettura

- **Vercel**, piano Hobby, regione fra1 (Francoforte). 12 funzioni TypeScript in `api/`: è il massimo del piano, una funzione nuova richiede di accorparne due.
- **Upstash Redis**: stato delle richieste, immagini dei post (base64, 7 giorni), loghi, coda, scelte newsletter.
- **Upstash QStash**: chiamate ritardate e pianificazioni in ora italiana, firmate (`lib/qstash.ts`, `firmaQstash`).
- **Vercel Blob**: i video dei caroselli (le funzioni non rispondono oltre 4,5 MB).
- **Canva Connect API**: upload, autofill `create_from_design`, export JPG qualità 92.
- **Groq**: ritaglio (persone nella foto), controllo delle grafiche, bozze delle didascalie. Modello `qwen/qwen3.8-27b` (`GROQ_VISION_MODEL`, `GROQ_TEXT_MODEL`), riserve `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` quando il primo ha finito i crediti del giorno.
- **Meta Graph API v23**: pubblicazione e statistiche.
- **Brevo**: newsletter.

Il webhook risponde subito a Telegram; il lavoro lungo continua in `waitUntil`. Ogni update si elabora una volta sola (Redis `upd:<update_id>`, 1 ora): Telegram ripete gli update lenti.

### Funzioni

| File | Ruolo |
|---|---|
| `api/telegram.ts` | Webhook: comandi, foto, bottoni. `/versione` risponde con la version di `package.json` (anche in gruppo di prova) |
| `api/cron-carosello.ts` | Risultati della settimana (QStash martedì 9:00) |
| `api/cron-settimana.ts` | Partite della settimana (QStash mercoledì 19:00) |
| `api/cron-news.ts` | Notizie CSI, controllo token Meta, report statistiche il 1° del mese (Vercel Cron 07:00 UTC) |
| `api/cron-newsletter.ts` | Anteprima newsletter (QStash venerdì 10:30) |
| `api/ig-auto.ts` | Post automatici dopo 30 minuti, giro della coda, riprova solo Instagram. Solo con firma QStash |
| `api/nl-invia.ts` | Invio newsletter dopo 30 minuti. Solo con firma QStash |
| `api/instagram.ts` | Login Meta e immagini servite a Instagram e Facebook |
| `api/canva-auth.ts`, `api/canva-callback.ts` | Login Canva (OAuth con PKCE) |
| `api/setup.ts` | Manutenzione: webhook, argomenti, pianificazioni QStash, logo mail, stato Brevo |
| `api/prova-crop.ts` | Prove sul server (ritaglio, controllo, bozza) |

### Argomenti del gruppo

Nomi in `lib/argomenti.ts` (`NOMI`), id dei thread in Redis hash `argomenti` (gruppo vero) o `argomenti:<chat>` (gruppo di prova). Crearli o rinominarli: `api/setup?key=..&argomenti=1`.

| Chiave | Nome | Contenuto |
|---|---|---|
| automatici | 🤖 Post automatici | Risultati e partite della settimana |
| manuali | ✍️ Post manuali | Copertine e caroselli fatti con le foto |
| novita | 📣 Novità ed eventi | Grafiche evento |
| csi | 📰 RSS CSI | Notizie CSI con 📧 e anteprima newsletter |
| statistiche | 📊 Statistiche | Report mensile e /metriche |
| errori | ⚠️ ERRORI | 3.0: errori in italiano semplice (per ora solo nel gruppo di prova) |

I comandi ricevono risposta nell'argomento in cui sono scritti (AsyncLocalStorage, `nelThread`); gli automatismi scrivono nel loro argomento fisso (`nellArgomento`). Generale chiuso ai membri dall'admin, guida fissata lì.

## 3. Flussi

### Copertina risultato e amichevole (`/risultato`, `/amichevole`)

1. Foto con `/risultato` in didascalia. Se la didascalia ha già tutto (`/risultato basket under 15 91 SSC - 32 PUOK`) si parte subito.
2. Senza punteggio: elenco delle partite di SS Cormano degli ultimi 7 giorni dai portali (`partiteRecenti`, max 12), bottoni `rp:<n>`; poi si scrive il punteggio, prima la squadra di casa (stato `partita` → `punti`). `➕ Altra partita` e `/amichevole`: sport, categoria e risultato scritto con le squadre (`lib/punteggio.ts`: `1 SSC - 3 PUOK`, `SSC 42 - 74 OSAL`, `SS Cormano 3 - Precotto 3`).
3. Loghi (`logoSquadra`): SS Cormano = asset `MAHYdM2v9n8`, poi Redis `loghi` (chiave = nome in grafica), poi logo del portale CSI. Se manca, il messaggio "⏳ Creo la grafica…" diventa "🛡 Manca il logo di X" (Redis `rlogo:<chat>:<msg>`, 1 giorno): risposta con l'immagine (salvata per le prossime volte) o `/salta`.
4. Ritaglio (`lib/crop.ts`), Canva autofill, export, copertina nel gruppo, messaggio del post per i social con la richiesta della didascalia.

### Carosello manuale

Altre foto o video in risposta alla copertina o al messaggio del post (Redis `igcover:<chat>:<msg>` → id del post). Ritaglio 4:5 a 1080x1350 (`ritaglia45`; Groq solo se il taglio supera il 10%), 👀 poi 👍 sulla foto, massimo 10 slide. Video da 3 a 60 secondi, massimo 20 MB, su Vercel Blob; su Facebook escono solo le foto. Ordine delle slide: sorted set `igord:<id>`.

### Didascalia (gruppo vero, 2.x)

Domanda "✍️ Scrivi la didascalia" con la bozza AI sotto (`lib/bozza.ts`, esempi dalle didascalie vere): ✅ Usa questa, 🔄 Un'altra, 🗣 Spiego io, ✍️ Scrivo io, oppure risposta con il testo. Senza didascalia il ✅ Pubblica non va.

### Evento (`/evento`)

Copertina fatta dal bot (titolo giallo SOPRATITOLO o Nessuno, poi sottotitolo bianco TITOLO) o foto propria come copertina. Due righe dopo `/evento` = titolo e sottotitolo senza domande. `titoloEvento()` sceglie il template con il titolo più grande che sta in larghezza. Didascalia: prima i punti chiave, poi la bozza.

### Risultati della settimana (martedì 9:00)

`lib/carosello.ts`: legge i portali (`aggiornaPartite`), prende le partite giocate degli ultimi 6 giorni, prepara le righe (categoria, nomi corti, loghi, punteggi), una slide ogni 5 righe, album in 🤖 Post automatici. Lancio a mano: `/carosello [giorni]`.

### Partite della settimana (mercoledì 19:00)

`lib/settimana.ts`: da domani a 7 giorni, avversario con logo, categoria corta, giorno e ora. Lancio a mano: `/settimana [giorni]`.

### Domande sui caroselli (`lib/domande.ts`)

Loghi mancanti, nomi oltre 13 caratteri senza alias, punteggi mancanti sul portale, campionati nuovi: una coda di domande (`domande:<chat>`), una alla volta in privato al referente (`loghi:referente`, ultimo che ha lanciato un carosello o risposto), ripiego sul gruppo. Risposta = immagine, testo o `/salta`. Dopo un nome corto, se per quel nome non c'è logo (né salvato né sul portale, `alias.logoUrl`), la domanda sul logo arriva subito dopo (dalla 3.1.1). Logo trovato online (`lib/cercalogo.ts`, dalla 3.2.0 in gruppo di prova, nel gruppo vero dalla 3.3.0): prima di chiedere un logo il bot cerca immagini con la Brave Search API (`BRAVE_API_KEY`, "<nome portale> basket logo") e le fa classificare a Groq vision (tipo logo/foto/volantino/altro, testo letto, appartenenza alla squadra); passa solo tipo logo con squadra vera, massimo 6 immagini controllate. Il primo buono arriva nella domanda come foto con ✅ Usa questo (`lgok:<chat>`) / 🔄 Un altro (`lgnx:<chat>`); la domanda resta aperta (immagine in risposta o /salta). Ricerca senza risultati: la domanda dice "🔎 Non ho trovato online il logo di …: mandalo tu". Tempo massimo 40 s, messaggio "🔎 Cerco online…" durante la ricerca. Candidati in `logocand:<chat>`. Prova sul server: `api/prova-crop?key=..&cerca=<nome>&lungo=<nome portale>`. A coda finita i caroselli si rifanno da soli. Comandi a mano: `/logo NOME` (didascalia di un'immagine), `/alias NOME PORTALE = NOME CORTO`.

### Pubblicazione automatica e controlli

Risultati e partite: controlli su grafiche (Groq vision: segnaposto, parole spezzate, testi sovrapposti, teste tagliate, foto mancante) e dati (portali, campionati sconosciuti, orari, domande aperte). Tutto a posto = in coda dopo 30 minuti con ❌ per fermare (`programma`, QStash, `igauto:<id>`); altrimenti serve un ✅. Una versione nuova dello stesso flusso entro 36 ore sostituisce la precedente non pubblicata.

### Coda di pubblicazione (`lib/instagram.ts`)

Il ✅ non pubblica: mette in coda (sorted set `igcoda`). Un post ogni 2 ore (`INTERVALLO_ORE`), mai tra le 23 e le 8 (`NOTTE_DA`, `NOTTE_A`). QStash chiama `api/ig-auto?coda=1` all'orario del primo (deduplica per orario). Lucchetto `iglock:<id>`: "coda", 1 (uscito), "annullato", "scaduto", "prova". Un post in coda allunga la vita delle sue immagini fino a 2 giorni dopo l'uscita. Bottoni sul messaggio: ❌ Togli dalla coda, ⚡ Pubblica subito, ✏️ Modifica didascalia, 🖼 Modifica foto. `/coda` = elenco. A coda finita: riepilogo nel Generale.

Hashtag e testo alternativo su Instagram (`lib/altTesto.ts`): `pubblicaIg` toglie dalla didascalia le ultime righe fatte di soli hashtag (`dividiHashtag`) e, dopo `media_publish`, li scrive nel primo commento con `POST /{media}/comments`; se il commento fallisce il post resta pubblicato e l'admin riceve un avviso. Le grafiche singole di risultato, amichevole e torneo passano anche `alt_text` (`testoAlternativo`, salvato in `Post.alt`). Facebook resta con la didascalia intera. Il commento parte solo se il login Facebook ha dato `instagram_manage_comments` (tolto nella 3.12.2 per "Invalid Scopes", rimesso nella 3.12.3 dopo averlo aggiunto all'app Meta; letto da `/me/permissions` e salvato in `ig:token.permessi`); senza, la didascalia resta intera con gli hashtag. Il 2/11 il commento era rifiutato con #10 e il post Under 17 è uscito senza hashtag.

Pubblicazione: Instagram con un container per slide e poi il carosello (attesa FINISHED); Facebook con foto non pubblicate e un post che le raccoglie. Sui post di tipo `risultato` il testo Facebook (e solo quello) riceve una domanda finale che invita a commentare, dopo la riga "Forza SS Cormano!" e prima degli hashtag: `conDomandaFb` in `lib/bozza.ts`, scelta per esito (vittoria, sconfitta, pareggio) e, tra due frasi, in modo stabile dal testo. Instagram e le bozze restano come sono. Dopo 3 settimane si confrontano le interazioni Facebook con `lib/metriche.ts`. Se non esce niente: ✅ Riprova e coda in pausa 1 ora. Se esce Facebook e non Instagram: riprova solo Instagram 3 volte ogni 15 minuti. Se ne esce uno solo, niente nuovo tentativo completo (sarebbe un doppione).

Tag delle avversarie (Issue 10, dalla 3.12.0, `lib/account.ts`): hash `igaccount` nome squadra → username ("-" = nessun account). `generaSettimana` chiama `chiediAccount` con le avversarie: all'admin in privato una domanda per squadra mai chiesta (chiave `igaccount:chiesto:<nome>` 30 giorni), risposta @nome controllata con Business Discovery, bottone ⏭ Non ha Instagram (`iga:<id>`). Il post salva `avversari` (nomi per slide); `pubblicaIg` mette `user_tags` su ogni slide al centro del logo della riga (x 0,519, y per riga 1..5: 0,394 0,510 0,614 0,705 0,821, uguali nei 5 template). Se Meta rifiuta i tag (dalla 3.12.1) `gestisciTagRifiutati` controlla account per account: chi non si trova prende un errore in `igaccount:errori`; al secondo l'account si toglie, si richiede all'admin e lui riceve un avviso. La slide riprova con i tag buoni, poi senza. Facebook senza tag.

Storie Instagram (Issue 4): quando un post di tipo `risultato`, `amichevole` o `torneo` (questi due dalla 3.11.0) esce su Instagram (anche al tentativo di `riprovaIg`), `pubblicaStoria` crea una storia con la copertina (prima slide di `igord`): `storiaDaCopertina` la mette intera al centro di un 1080x1920 su sfondo sfocato della stessa foto, salvata in `igimg:<id>:99`, poi container `media_type=STORIES` e `media_publish` (stesso permesso instagram_content_publish). Niente storia per eventi, post foto e caroselli. Mai bloccante: se fallisce, avviso solo all'admin. In gruppo di prova il ✅ non pubblica, ma il bot mostra in chat la storia che uscirebbe. Prova: `scripts/prova-idea-4.ts`.

### Notizie CSI e newsletter

- `api/cron-news` ogni giorno: home del CSI Milano (`lib/news-csi.ts`, 3 tentativi), solo notizie nuove in 📰 RSS CSI con 📧. Una notizia è "vista" solo dopo l'invio.
- `lib/newsletter.ts`: venerdì 10:00 anteprima con le notizie segnate 📧, ❌/✅, invio dopo 30 minuti (`ATTESA_MIN`) tramite QStash su `api/nl-invia`. Nessuna notizia = nessuna mail. `/newsletter` = anteprima subito. Una nuova anteprima sostituisce la precedente.
- Brevo: liste Allenatori (5) e Dirigenti (4), mittente news@example.org, dominio autenticato. Live con `NEWSLETTER_LIVE=1` (dal 13 ottobre 2026), altrimenti solo a `NEWSLETTER_TEST_EMAIL`.

### Statistiche

`lib/metriche.ts` e `lib/dashboard.ts` (@vercel/og 0.8.5): follower, copertura, interazioni, migliori post di Instagram e Facebook, confronto con il periodo prima. Il 1° del mese in 📊 Statistiche (salvato in `metriche:AAAA-MM`), `/metriche [giorni]` a richiesta. Click dal sito verso lo sponsor nel report.

Registro dei post pubblicati (`lib/registro.ts`, dalla 2.21.0): quando un post esce su almeno un canale, `esegui()` scrive `pub:<id>` **senza scadenza** e aggiunge l'id al sorted set `pubblicati` (punteggio = uscita). Scheda: tipo (risultato, amichevole, torneo, post foto, evento, carosello risultati, partite della settimana; passato da `proponiInstagram` con `tipo`, altrimenti ricavato da `flusso` ed `evento`), categoria, automatico, origine del testo (automatica, bozza AI, cronaca del coach, scritta a mano: confronto tra testo uscito e `igbozza`), slide, video, chi ha messo in coda, ora del ✅ (`igcodats:<id>`), id e link per canale (id da `pubblicaIg`/`pubblicaFb` in `igpubid:<id>`). `riprovaIg` completa la scheda quando Instagram esce dopo. Alla prima uscita QStash programma `api/ig-auto?stat=<id>` dopo 7 giorni meno un'ora (limite di ritardo di QStash): `statistichePost` scrive in `stat` reach, total_interactions, saved, shares, views (IG) e reazioni e condivisioni (FB; la copertura dei singoli post FB Meta non la dà più). Ogni errore del registro va solo in privato all'admin, mai blocca la pubblicazione. Prova: `scripts/prova-registro.ts`. Storico prima del registro: `scripts/storico.ts` → `docs/statistiche/storico-set-ott.csv` (solo lettura).

Instagram accetta al massimo 30 giorni tra since e until: i totali dell'account si chiedono a pezzi di 30 giorni e si sommano (per gli account raggiunti è una somma, non persone uniche). I nuovi follower Instagram esistono solo per gli ultimi 30 giorni: se il periodo ne resta fuori per più di 2 giorni il numero è "n.d.". Dal 2.23.0 anche le visualizzazioni Instagram (`views`). La scheda del registro salva anche `ente` (solo risultati) e `follower` (follower Instagram all'uscita).

Statistiche 3.0 (`lib/report.ts`, decisioni in `.claude/context/statistiche-3.0.md`): periodi mese, trimestre, semestre, stagione (settembre → agosto; trimestri da settembre, dicembre, marzo e giugno). Crescita = somma dei mesi `metriche:AAAA-MM` (un mese finito che manca si legge da Meta e si salva); confronto con il periodo uguale prima solo per periodi chiusi. "Cosa tira" = classifiche dal registro: reach Instagram a 7 giorni / follower all'uscita, media per gruppo; prime 5 categorie e sport con risultati e amichevoli, CSI / FIP / UISP solo risultati; sotto 3 post "pochi dati" in grigio e in fondo. Invio (`inviaPeriodo`): dashboard e testo come prima, immagine "Cosa tira" (`cosaTira` in `lib/dashboard.ts`), riga 🏆 con il verdetto. Con la 3.0 il 1° del mese il cron manda il mese chiuso e, se chiudono, trimestre, semestre e stagione (cron-news fino a 300 secondi). `/metriche mese|trimestre|semestre|stagione` = periodo in corso fino a oggi; `/metriche [giorni]` resta.

### Pulizia (`/reset`)

Con la coda vuota cancella i messaggi di ✍️ Post manuali e del Generale delle ultime 48 ore (quanto dura la coda), tranne la guida fissata. Dal 2.25.0 l'argomento non si cancella più: ricreato perdeva il fissato in cima, e i bot non possono fissare gli argomenti (pinForumTopic non esiste nella Bot API). I messaggi dell'argomento, del bot e dei volontari, si annotano man mano in `manuali:msg:<chat>` (`ricordaGenerale` in `lib/telegram.ts`), come quelli del Generale in `generale:msg`. Se l'argomento non c'è ancora, la pulizia lo crea. Prova: `scripts/prova-pulizia.ts`. Un solo /reset alla volta (lucchetto `reset:lock:<chat>` di 2 minuti); se /reset è scritto in un argomento che il bot non conosce (un ✍️ Post manuali doppio) cancella anche quello.

## 4. Fonti dati

| Fonte | Cosa dà | File |
|---|---|---|
| CSI Milano | Calcio, volley, basket giovanile: calendario, risultati, loghi | `lib/fonti/csi.ts` |
| FIP | Basket DR2 (dalla rete dell'ufficio a volte non risponde) | `lib/fonti/fip.ts` |
| UISP | Basket giovanile | `lib/fonti/uisp.ts` |
| Sito CSI Milano | Notizie della home | `lib/news-csi.ts` |

- CSI: "REC." nel punteggio = recupero, gara già rispostata a una data nuova: si gioca e va nelle partite della settimana. Rinviata (fuori dalle grafiche, nota ↪️) solo con "RINV.".
- Campionati → categorie in `lib/partite.ts` (`CAMPIONATI`), da aggiornare a ogni stagione. Un campionato sconosciuto si propone all'admin (`lib/campionati.ts`) e toglie l'automatico.
- Nomi: categoria o colore finale tolti (`pulisciNome`), alias salvati (`alias`) vincono, massimo 13 caratteri.
- Zero gare su CSI o FIP a stagione in corso = scraper rotto, non "nessuna partita".
- Punteggio dato in chat quando il portale non ce l'ha: vale solo per il carosello (`risman:<id>`, 60 giorni). Una partita di oggi si chiede solo 2 ore dopo l'orario d'inizio, senza orario dal giorno dopo (dalla 3.12.5). Gare sparite dal portale: CSI e UISP leggono tutta la stagione, quindi a ogni aggiornamento (`aggiornaPartite`) le gare salvate di quell'ente che il portale non restituisce più vengono tolte (`togliSparite`, dalla 3.12.6). FIP no, legge solo una finestra di giorni. Con 0 gare non si toglie niente.

## 5. Canva

Autofill su design normali usati come template. Si cambia il template su Canva e il bot usa subito la versione nuova; ma un template nuovo (copia) va scritto nel codice ed è una release. Duplicando un box si eredita la sua etichetta di autofill: va sempre controllata.

Cartelle: "Bot · Template" (in uso), "Bot · Template vecchi" (ritorni), "Bot · Grafiche/AAAA-MM" (generate; al primo uso di un mese nuovo si cancellano le cartelle più vecchie di 2 mesi, il contenuto va nel Cestino), "Bot · Prove" (design degli script, svuotata insieme).

| Template | ID | Campi |
|---|---|---|
| Copertina risultato (con Sponsor) | `DAxxxxxxxxx` | FOTO, RISULTATO, CATEGORIA, SQUADRA_A, SQUADRA_B, LOGO_A, LOGO_B |
| Copertina amichevole (con Sponsor) | `DAxxxxxxxxx` | come il risultato |
| Copertina torneo (con Sponsor, dalla 3.7.0) | `DAxxxxxxxxx` | FOTO, CATEGORIA, SQUADRA_A, SQUADRA_B, LOGO_A, LOGO_B (niente RISULTATO): scritta TORNEO, logo SS Cormano e logo di chi organizza affiancati al centro (131x160), nomi sotto. Ritorno: `DAxxxxxxxxx` (3.6.0, come l'amichevole) |
| 3.0 Copertina risultato con logo del campionato (solo prova) | `DAxxxxxxxxx` | come il risultato, più LOGO_ENTE (asset CSI `MAHZMJSmagg`, FIP `MAHZMNHV1oE`, UISP `MAHZMLryXko`, originali in `docs/enti/`) |
| Evento, titolo 121 px | `DAxxxxxxxxx` (`CANVA_TEMPLATE_EVENTO_ID`) | FOTO, SOPRATITOLO, TITOLO |
| Evento, titolo 97, 81, 66, 55 px | `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx` | come Evento |
| Risultati della settimana, 5…1 partite | `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx` | DATA, R{n}_CAT, CASA, PC, PO, OSP, LCASA, LOSP |
| Partite della settimana, 5…1 righe | `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx`, `DAxxxxxxxxx` | DATA, R{n}_AVV, LOGO, CAT, ORA |

I template di ritorno (versioni precedenti) sono scritti nei commenti accanto agli ID in `lib/pipeline.ts`, `lib/carosello.ts`, `lib/settimana.ts`.

Vincoli: nomi nei caroselli massimo 13 caratteri; box categoria circa 16 caratteri (`catBreve`: "U14 BASKET"); mai parole spezzate (si riduce il testo sul template, non si va a capo); logo del club piccolo in alto a sinistra per non coprire i volti; loghi squadra in proporzione 348x424 su fondo trasparente (`salvaLogo`, il bianco attaccato ai bordi diventa trasparente). Limiti Canva: 75 export ogni 5 minuti, 500 al giorno.

## 6. Ritaglio delle foto

`lib/crop.ts` e `lib/soggetti.ts`. Solo taglio, mai riempimenti o sfondi sfocati. Groq trova la fascia delle persone; 15% di margine sopra le teste. Copertine: area foto del template; caroselli: 4:5. Senza Groq o con errore: regola fissa. Se le persone non si trovano o la foto è troppo larga, il bot avvisa.

## 7. Meta

App Meta dedicata al bot (quella del sito non si tocca). Login Facebook (`META_LOGIN` predefinito "facebook"), token di Pagina che non scade, in Redis `ig:token`. Login: `api/instagram?key=<SETUP_SECRET>`. Il bot controlla ogni giorno il token e manda all'admin il link se serve.

Permessi: pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management, instagram_manage_insights, read_insights. **Mai pages_read_user_content**: "Invalid Scopes", blocca il login.

## 8. Orari

| Automatismo | Quando | Chi lo avvia |
|---|---|---|
| Risultati della settimana | Martedì 9:00 ora italiana | QStash `carosello-martedi`, nessun nuovo tentativo |
| Partite della settimana | Mercoledì 19:00 ora italiana | QStash `settimana-mercoledi`, nessun nuovo tentativo |
| Anteprima newsletter | Venerdì 10:30, invio 12:00 (3.0) | QStash `newsletter-venerdi`, 2 tentativi |
| Promemoria risultati mancanti | Lunedì 20:00 | QStash `promemoria-lunedi`, nessun nuovo tentativo |
| Notizie CSI, token Meta, report del 1° | Ogni giorno 07:00 UTC, dentro l'ora | Vercel Cron |

Pianificazioni QStash create o rifatte con `api/setup?key=..&pianifica=1` (lista `PIANO`). Le funzioni accettano POST firmato QStash o GET con `CRON_SECRET` (lancio a mano).

## 9. Variabili sul server (solo nomi)

- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_CHAT_IDS`, `ADMIN_CHAT_ID`
- Protezioni: `SETUP_SECRET`, `CRON_SECRET`, `BASE_URL`
- Canva: `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_TEMPLATE_EVENTO_ID`
- Groq: `GROQ_API_KEY`, `GROQ_VISION_MODEL`, `GROQ_TEXT_MODEL`
- Meta: `IG_APP_ID`, `IG_APP_SECRET`, `META_LOGIN`
- Upstash: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_*`), `QSTASH_TOKEN`, `QSTASH_URL`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`
- Newsletter: `BREVO_API_KEY`, `NEWSLETTER_LIVE`, `NEWSLETTER_TEST_EMAIL`, `NEWSLETTER_LISTE`, `NEWSLETTER_MITTENTE_NOME`, `NEWSLETTER_MITTENTE_EMAIL`
- Prove: `IG_CODA_PREFIX` (coda di prova degli script)
- Pipeline: `GH_PIPELINE_TOKEN` (token GitHub dell'admin, solo Issue e Pull Request di questo repository)

Cambiare una variabile cambia il comportamento del bot: è una release. `GROQ_API_KEY` è segnata come sensibile su Vercel: in locale arriva vuota, l'AI si prova sul server (`api/prova-crop`).

## 10. Sicurezza

- Webhook con `TELEGRAM_WEBHOOK_SECRET`; comandi solo da `ALLOWED_CHAT_IDS` più il gruppo di prova; cron con `CRON_SECRET`; setup, login e prove con `SETUP_SECRET`; OAuth Canva con state e PKCE; `ig-auto` e `nl-invia` solo con firma QStash.
- La pubblicazione automatica esce solo per i post segnati `igauto:<id>`: un post che aspetta il ✅ non esce da lì.
- Chiavi solo su Vercel e nel `.env` locale (ignorato da git). Repository GitHub privato tuo-utente/tuo-repo.
- Chi è nel gruppo può approvare una pubblicazione: l'ingresso nel gruppo va controllato.

## 11. Gruppo di prova e 3.0

Gruppo **gruppo di prova** -1001234567890 (`lib/prova.ts`). `v3(chat)` accende le novità della 3.0: dal lancio del 28/10/2026 (3.0.0) vale anche per il gruppo vero (il gruppo in `ALLOWED_CHAT_IDS`). Le novità nuove si provano prima qui. Gruppo vero: argomento ⚠️ ERRORI creato dal bot al lancio (id in `argomenti.errori`, chiuso), ✍️ Post manuali ricreato il 28/10 (da fissare a mano: i bot non possono). In prova il bot non pubblica mai sui social e non usa la coda vera (✅ → "🧪 PROVA"), e i comandi che toccano coda, caroselli, newsletter e argomenti del gruppo vero non partono. Argomenti di prova: manuali 182, automatici 18, errori 19 (chiuso).

Attivo nel gruppo vero e in prova:
- foto senza testo → menu 🏆 Risultato, 📷 Post foto, ✖️ Niente (stato `menu`); foto in un altro argomento → menu in ✍️ Post manuali. Senza scelta il menu sparisce dopo 10 minuti (QStash `api/ig-auto?menu=<chat>&utente=<id>&msg=<menu>`, `chiudiMenu` in `lib/reset.ts`: tocca solo se la richiesta è ancora ferma su quel menu);
- scheda unica del post (`scheda`, `nuovaBozza`): avvisi in cima, foto, testo, ✅ Pubblica con questo testo (`igp3`), 🔄 Un'altra, 📝 Usa il mio testo così com'è (`igmy`);
- risposta alla scheda: testo corto = indicazioni per la bozza, oltre 200 caratteri = cronaca del coach (`testoCronaca`: l'AI sceglie e accorcia, `soloTagli` garantisce le parole del coach nello stesso ordine; titolo, risultato e hashtag dal codice; note `ignote` per punteggio diverso e nome avversario corretto);
- 📷 Post foto (`generaPostFoto`): foto ritagliata come copertina, senza Canva;
- errori dei post in ⚠️ ERRORI;
- 🤝 Amichevole (`rp:a`), 🏅 Torneo (`rp:t`, tipo `torneo`) e ➕ Altra partita (`rp:x`) in fondo all'elenco, presenti anche quando l'elenco delle partite è vuoto (anche `/amichevole`): tre domande, squadra nostra con un bottone (sport e categoria, callback `a3`), nome dell'avversario, punteggio con SS Cormano per prima (stati `squadra`, `avversario`, `puntiLV`). In ➕ Altra partita, dopo la squadra, il campionato con quattro bottoni CSI, FIP, UISP, Nessuno (`en:<ente>`, stato `ente`);
- 🏅 Torneo (dalla 3.7.0): partecipazione, non una partita. Due domande: squadra nostra (`a3`) e chi organizza (stato `avversario`, nome in SQUADRA_B), niente punteggio; la grafica parte subito sul template torneo (SQUADRA_A = SS CORMANO con `LOGO_LV`). Didascalia della copertina `TORNEO ORGANIZZATO DA <NOME>` e categoria: la bozza usa `PROMPT_TORNEO` (niente risultati inventati), la cronaca del coach ha il titolo `<CATEGORIA> | TORNEO`. Logo di chi organizza mancante: prima la ricerca online di `lib/cercalogo.ts` (stesse chiavi Brave e Groq dei caroselli, sport della categoria nella ricerca, candidati in `logocand:t:<chat>:<foto>`), proposta in foto con ✅ Usa questo (`tlok`) / 🔄 Un altro (`tlnx`); alla proposta si risponde anche con l'immagine o /salta (chiave `rlogo:<chat>:<proposta>`). Niente online o chiavi mancanti: la domanda di sempre. Il torneo non conta per il promemoria dei risultati;
- logo del campionato sui risultati (`TEMPLATE_V3_RISULTATO`): partita dall'elenco = ente della partita sul portale, partita fuori elenco = bottone scelto. Nessuno = campo vuoto. Logo in alto a destra, lontano dal contatore 1/x dei caroselli Instagram; Sponsor accanto al logo SS Cormano. I tre loghi in alto sono alti 60 px (60% di prima) per non coprire le teste. Le amichevoli restano sul loro template;
- domande dei caroselli (`lib/domande.ts`, `chiediV3`): nell'argomento 🤖 Post automatici, mai in privato. Un messaggio elenco con l'avanzamento e ⏭ Salta tutte (`dsk:<chat>:<giro>`), una domanda alla volta in un messaggio suo, con ⏭ Salta questa (`dsq:<chat>`, dalla 3.12.4: vale come /salta in risposta). Dopo 2 ore avviso, dopo 3 ore si salta quello che manca (QStash `api/ig-auto?domande=<chat>&giro=<n>&fase=avviso|scadenza`) e la nota va in ⚠️ ERRORI. A domande finite il carosello si rifà sempre;
- newsletter (`lib/newsletter.ts`, `anteprimaV3`): le notizie entrano in silenzio nella newsletter della settimana (`nl:settimana:<chat>`, "viste" per chat); quelle con le parole chiave (Powervolley, Inter, residenziale, camp, iscrizioni, scadenza, torneo, selezione) escono subito con 📧 Manda subito (`nlu`). Anteprima con tutte dentro e ✖️ per togliere (`nlt`), invio 90 minuti dopo. In prova mai una mail;
- reset automatico (`lib/reset.ts`): a coda finita senza errori pulisce ✍️ Post manuali se non ci sono post aperti, domande o richieste a metà; altrimenti riprova ogni 30 minuti (`api/ig-auto?reset=<chat>`, al massimo 12 volte). /reset usa la stessa pulizia (`pulisciManuali`);
- promemoria dei risultati (`lib/promemoria.ts`): lunedì alle 20 (QStash `promemoria-lunedi` → `api/ig-auto` con l'intestazione `Promemoria: 1` (il piano Hobby ammette 12 funzioni, le pianificazioni non accettano "?")) un messaggio in ✍️ Post manuali con le partite di SS Cormano degli ultimi 6 giorni senza post risultato. Fatta = post risultato o amichevole della stessa categoria (il torneo no, dalla 3.7.0) pubblicato (registro) o con ✅, dal giorno della partita; per categoria, così vale anche ➕ Altra partita. Niente da segnalare, nessun messaggio. A richiesta `/promemoria`;
- comandi solo di prova: `/notizie` (lettura della home come il cron), `/fine` (come la coda finita). In prova la pubblicazione automatica dei caroselli è spenta.

Piano completo e pezzi mancanti: `.claude/context/piano-3.0.md`.

## 12. Release

- Ogni modifica è una release: codice pubblicato, template Canva, variabili, orari. Non contano script di prova, appunti, login rifatti.
- Voce in fondo a `docs/registro/releases.json`: versione, tipo, gruppo, tecnico, verifica, autore, file, guida, manuale. Poi `npm run release`.
- Versione: correzione = terzo numero, funzione = secondo, cambio grosso = primo.
- `npm run release` rifiuta la voce se mancano campi, se la versione è sbagliata, se ci sono file cambiati non dichiarati (lavoro di altre sessioni), se `guida` o `manuale` dicono "aggiornata/aggiornato" ma il file non è cambiato o viceversa. Poi typecheck, guida e registro rigenerati, deploy, controllo di avvio (403 senza chiave), commit, tag, push, messaggio all'admin con il link al registro. Guida aggiornata = PDF nel Generale, fissato.
- Deploy diretti bloccati da `.claude/hooks/blocca-deploy.js`.
- Dopo la release: ripubblicare `docs/registro/index.html` sull'Artifact del registro (link in `docs/registro/artifact.txt`).
- Tornare indietro: file del tag buono + release di correzione; emergenza: promuovere il deploy precedente dal pannello Vercel.

## 13. Prove

| Script | Cosa prova |
|---|---|
| `scripts/verifica.ts` | Portali, notizie, argomenti, token Meta, domande (a secco) |
| `scripts/prova-3.ts <foto>` | La 3.0 nel gruppo di prova, sul bot in produzione |
| `scripts/prova-risultato-partita.ts` | /risultato con Canva e Redis veri, Telegram finto |
| `scripts/prova-coda.ts` | Coda di pubblicazione su una coda di prova |
| `scripts/prova-newsletter.ts` | Newsletter con Brevo e QStash intercettati |
| `scripts/prova-bot.ts` | Copertina e carosello nella chat dell'admin |
| `scripts/prova-idea-1.ts` | `/versione` da gruppo di prova, sull'anteprima |
| `scripts/attese-ig.ts` | Pubblicazioni delle ultime 2 ore, prima di toccare la pubblicazione |
| `scripts/news-check.ts` | Notizie della home non ancora mandate |
| `scripts/prova-evento.ts`, `prova-titolo-evento.ts` | Grafica evento |
| `scripts/prova-sharp.ts`, `test-crop*.ts` | Ritaglio |

Il `QSTASH_TOKEN` del `.env` locale dà 401: gli script locali non programmano i giri della coda.

## 14. Decisioni e motivi

| Decisione | Motivo |
|---|---|
| Canva vero, non grafica composta dal codice | Il template si cambia su Canva senza programmatori |
| Bot nel gruppo Telegram | Essere nel gruppo vale come autorizzazione |
| Solo taglio delle foto, con riconoscimento persone | Riempimenti bocciati; le regole fisse tagliavano teste |
| Mai parole spezzate | Si riduce il testo sul template |
| Automatico solo per risultati e partite | Le grafiche fatte a mano meritano uno sguardo umano |
| Chiunque nel gruppo può ✅ o ❌ | Nessun collo di bottiglia |
| Doppia pubblicazione dal bot | Il crossposting di Instagram non è garantito per i post da API |
| App Meta separata | Quella del sito non va toccata |
| Gruppo ad argomenti | Automatici, manuali, notizie e numeri non si mescolano |
| Coda con un post ogni 2 ore | Calendario regolare, mai di notte |
| Orari in ora italiana con QStash | Il cron di Vercel è in UTC e parte "dentro l'ora" |
| Le parole del coach non si riscrivono | Il racconto è suo: si taglia e si corregge, non si inventa |
| Gruppo di prova per la 3.0 | Le novità si provano dal telefono prima di arrivare ai volontari |
| Release obbligatorie con registro | Sapere sempre cosa gira, perché e come tornare indietro |

## 15. Pipeline degli aggiornamenti

Ogni 2 settimane Claude propone le idee, l'admin sceglie, Claude sviluppa e prova, l'admin rilascia. Decisioni in `.claude/context/pipeline-aggiornamenti.md`. Tutto su GitHub Actions con Claude Code (token dell'abbonamento dell'admin, Secret `CLAUDE_CODE_OAUTH_TOKEN`); chiavi del bot nei Secrets del repo (Redis, Telegram, gruppi, BASE_URL).

- Contatori (`lib/eventi.ts`): `conta(evento, chat)` in `eventi:AAAA-MM-GG` per 120 giorni, il gruppo di prova non conta. Eventi: menu aperto, scelto (risultato, foto, niente) o scaduto; `/annulla`; logo caricato o saltato; 🔄 Un'altra, pubblica con la bozza o con il proprio testo, cronaca del coach; domande saltate o scadute.
- Errori (`registraErrore`): ultimi 300 in `log:errori`, sia quelli di ⚠️ ERRORI (`generale()`) sia gli avvisi tecnici all'admin (`avvisaAdmin`).
- Dossier (`scripts/dossier.ts`, solo lettura): contatori, registro dei post, Cosa tira, crescita da Meta, errori raggruppati, risultati mancanti, release delle 2 settimane → `dossier/dossier.md`.
- Idee (`.github/workflows/idee.yml`, domenica alle 18 UTC nelle settimane pari, o a mano): dossier, poi Claude Code con `.github/prompts/idee.md` (solo lettura, ricerca web, scrive `dossier/idee.json`), poi `scripts/pubblica-idee.ts`: Issue con etichette `idea`, `lavoro: piccolo|medio|grande`, `con l'admin` e messaggio in privato all'admin. Dossier e idee restano 30 giorni tra gli artefatti del giro.
- Bottoni (`lib/pipeline-github.ts`, dalla 3.4.0): nel messaggio delle idee ✅ #N (`gh:scelta:<Issue>`, niente bottone per lavoro grande e 🤝), nel messaggio della prova 🚀 Rilascia a tutti (`gh:rilascia:<PR>`). Solo l'admin nella sua chat privata. Il bot mette l'etichetta su GitHub con `GH_PIPELINE_TOKEN`: con il token dell'admin l'etichetta fa partire i workflow. Se GitHub rifiuta, il bot lo dice e l'etichetta si mette a mano.
- Lavoro e prova (`.github/workflows/lavoro.yml`): etichetta `scelta` → Claude Code sul ramo `idea-<N>` con `.github/prompts/lavoro.md`, Pull Request, anteprima Vercel e prova in gruppo di prova (`scripts/anteprima.ts`, `scripts/prova-idea-<N>.ts`), fino a 2 correzioni, esito all'admin.
- Rilascio (`.github/workflows/rilascio.yml`): etichetta `rilascia` sulla PR → squash in main, `scripts/prepara-rilascio.ts` dà la versione alla voce `docs/registro/in-arrivo/<N>.json`, `npm run release`, PR e Issue chiuse. Più rilasci insieme (più idee scelte nello stesso giro) vanno in fila: gruppo di concorrenza per PR e passo "Aspetta il turno" che attende i rilasci partiti prima (con un gruppo unico GitHub annullava i rilasci in attesa oltre il primo, 1/11). Se un rilascio fallisce o viene annullato l'admin riceve un avviso; un conflitto con main (due idee che toccano lo stesso file) va risolto sul ramo idea-<N> e il rilascio rilanciato.

## 16. Punti aperti

- Risultati volley a set: da controllare al primo carosello con partite di volley giocate.
- La lista dei messaggi del Generale (`generale:msg`) vale solo per il gruppo vero: dal 2.20.0 il gruppo di prova non ci scrive.
