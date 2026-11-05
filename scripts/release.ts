// npm run release: l'UNICO modo di pubblicare il bot (regola dell'admin 2026-10-09).
// Prima si aggiunge la voce nuova in fondo a docs/registro/releases.json, poi si lancia questo comando.
//   1. controlla la voce (versione giusta per il tipo, campi pieni, verifica, guida e manuale dichiarati)
//   2. typecheck
//   3. aggiorna versione in package.json, data/ora/ritorno nella voce, rigenera registro (pagina) e guida
//   4. deploy su Vercel e controllo che le funzioni si avviino
//   5. commit + tag vX.Y.Z + push su GitHub
//   6. messaggio all'admin in privato con il link al registro (niente PDF dal 2.19.0)
// Dopo: la sessione ripubblica docs/registro/index.html sull'Artifact del registro (la release non può farlo).
// Se qualcosa fallisce prima del deploy, i file tornano come prima.
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { FILE_GUIDA_PDF, FILE_RELEASES, Release, Testo, dataIt, generaGuida, generaRegistro, leggiReleases, linkRegistro, piatto, punti } from "./documenti";

const ROOT = resolve(__dirname, "..");
const PKG = resolve(ROOT, "package.json");
// Messaggio della guida fissato nel gruppo: serve per toglierlo dal fissato quando arriva la versione nuova
const FILE_FISSATA_REL = "docs/guida-fissata.json";
const FILE_FISSATA = resolve(ROOT, FILE_FISSATA_REL);
for (const f of [".env", ".env.local"]) {
  try {
    for (const l of readFileSync(resolve(ROOT, f), "utf8").split("\n")) {
      const m = l.match(/^([A-Z_]+)="?(.*?)"?\r?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* file assente */
  }
}

const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// File cambiati secondo git, percorsi interi. Niente trim sull'output: "git status --porcelain" inizia le righe con
// lo stato in 2 colonne (" M file"), e togliere lo spazio iniziale tagliava una lettera al primo file (bug 2026-10-10)
const fileCambiati = () =>
  execSync("git -c core.quotepath=false status --porcelain --untracked-files=all", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!);
const ferma = (msg: string): never => {
  console.error(`\n❌ Release rifiutata: ${msg}\n`);
  process.exit(1);
};
const passo = (msg: string) => console.log(`• ${msg}`);

type V = [number, number, number];
const parse = (v: string): V => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) ferma(`versione "${v}" non valida, serve tipo 1.4.2`);
  return [Number(m![1]), Number(m![2]), Number(m![3])];
};
const attesa = ([a, b, c]: V, tipo: Release["tipo"]): string =>
  tipo === "cambio grosso" ? `${a + 1}.0.0` : tipo === "funzione" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;

const ora = new Date();
const oggi = ora.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }); // AAAA-MM-GG
const hhmm = ora.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });

async function telegram(metodo: string, body: FormData | Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${metodo}`;
  const r = body instanceof FormData ? await fetch(url, { method: "POST", body }) : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${metodo}: ${j.description}`);
  return j.result;
}

(async () => {
  // 1. Controllo della voce
  const releases = leggiReleases();
  const nuova = releases[releases.length - 1];
  const pkgTesto = readFileSync(PKG, "utf8");
  const relTesto = readFileSync(FILE_RELEASES, "utf8");
  const corrente = JSON.parse(pkgTesto).version as string | undefined;
  if (!corrente) ferma("package.json senza version");
  if (nuova.versione === corrente) ferma(`manca la voce nuova in docs/registro/releases.json (l'ultima è ${corrente}, già pubblicata)`);
  if (nuova.ricostruita) ferma("la voce nuova non può essere \"ricostruita\"");
  if (!["correzione", "funzione", "cambio grosso"].includes(nuova.tipo)) ferma(`tipo "${nuova.tipo}": usa correzione, funzione o cambio grosso`);
  const giusta = attesa(parse(corrente!), nuova.tipo);
  parse(nuova.versione);
  if (nuova.versione !== giusta) ferma(`dopo ${corrente} una ${nuova.tipo} è ${giusta}, non ${nuova.versione}`);
  for (const campo of ["gruppo", "tecnico", "verifica", "autore"] as const) {
    if (!piatto(nuova[campo] as Testo).trim()) ferma(`campo "${campo}" vuoto${campo === "verifica" ? ": scrivi quale prova reale dimostra che funziona" : ""}`);
  }
  if (piatto(nuova.verifica).trim().length < 15) ferma("verifica troppo vaga: descrivi la prova fatta");
  if (!sh("git rev-parse --is-inside-work-tree")) ferma("la cartella non è un repository git");
  const segreti = fileCambiati().filter((p) => /(^|\/)\.env/.test(p));
  if (segreti.length) ferma(`file di chiavi non ignorati da git: ${segreti.join(", ")}`);
  // Più sessioni lavorano nella stessa cartella: una release prendeva anche il lavoro a metà degli altri
  // (2026-10-10, modifiche alla newsletter uscite nella 1.0.1 senza essere descritte). Entra solo ciò che la voce dichiara.
  if (!Array.isArray(nuova.file) || !nuova.file.length) ferma('campo "file" vuoto: elenca i file o le cartelle toccati, es. ["lib/newsletter.ts", "docs/"]');
  const GENERATI = ["package.json", "docs/registro/releases.json", "docs/registro/index.html", "docs/guida-bot.html", "docs/Guida bot social SS Cormano.pdf", FILE_FISSATA_REL];
  const cambiati = fileCambiati();
  // La guida utenti è rimasta ferma dalla 1.7 alla 2.5 (2026-10-20): ogni release dice se la cambia
  const guida = (nuova.guida || "").trim();
  const guidaCambiata = cambiati.includes("docs/guida-bot.src.html");
  if (!/^(aggiornata|invariata):\s*\S.{4,}/i.test(guida)) {
    ferma('campo "guida" mancante: scrivi "aggiornata: cosa cambia per il gruppo" oppure "invariata: perché" (es. "invariata: cambio solo tecnico")');
  }
  const guidaAggiornata = /^aggiornata/i.test(guida);
  if (guidaAggiornata && !guidaCambiata) ferma('"guida: aggiornata" ma docs/guida-bot.src.html non è cambiata');
  if (!guidaAggiornata && guidaCambiata) ferma('docs/guida-bot.src.html è cambiata: scrivi "guida: aggiornata: cosa cambia", così arriva nel gruppo');
  // Il manuale tecnico deve restare vero (2026-10-26): ogni release dice se lo cambia
  const manuale = (nuova.manuale || "").trim();
  const manualeCambiato = cambiati.includes("docs/manuale.md");
  if (!/^(aggiornato|invariato):\s*\S.{4,}/i.test(manuale)) {
    ferma('campo "manuale" mancante: scrivi "aggiornato: cosa cambia" oppure "invariato: perché" (es. "invariato: correzione interna")');
  }
  if (/^aggiornato/i.test(manuale) && !manualeCambiato) ferma('"manuale: aggiornato" ma docs/manuale.md non è cambiato');
  if (!/^aggiornato/i.test(manuale) && manualeCambiato) ferma('docs/manuale.md è cambiato: scrivi "manuale: aggiornato: cosa cambia"');
  const coperto = (p: string) => GENERATI.includes(p) || nuova.file!.some((f) => p === f || (f.endsWith("/") && p.startsWith(f)));
  const estranei = cambiati.filter((p) => !coperto(p));
  if (estranei.length) {
    ferma(`file cambiati che la voce non dichiara (forse lavoro di un'altra sessione):\n  ${estranei.join("\n  ")}\nAggiungili a "file" se fanno parte di questa release, altrimenti aspetta che chi li sta cambiando finisca.`);
  }
  passo(`voce ${nuova.versione} (${nuova.tipo}) ok, ${cambiati.length} file cambiati, tutti dichiarati`);

  // 2. Typecheck
  try {
    sh("npx tsc --noEmit -p .");
  } catch (e: any) {
    ferma(`il codice non passa il typecheck:\n${e.stdout || e.message}`);
  }
  passo("typecheck ok");

  // 3. Versione, voce completata, registro e guida
  nuova.data = oggi;
  nuova.ora = hhmm;
  nuova.ritorno ||= `Ripristinare i file del tag v${corrente}, registrare una correzione e lanciare npm run release. Emergenza: promuovere il deploy precedente dal pannello Vercel.`;
  const ripristina = () => {
    writeFileSync(PKG, pkgTesto);
    writeFileSync(FILE_RELEASES, relTesto);
  };
  try {
    writeFileSync(PKG, pkgTesto.replace(/"version":\s*"[^"]*"/, `"version": "${nuova.versione}"`));
    writeFileSync(FILE_RELEASES, JSON.stringify(releases, null, 2) + "\n");
    generaRegistro(releases);
    generaGuida();
  } catch (e) {
    ripristina();
    ferma(`registro o guida non generati: ${(e as Error).message}`);
  }
  passo("registro e guida aggiornati");

  // 4. Deploy e controllo di avvio
  let deploy = "";
  try {
    // Su GitHub Actions (rilascio.yml) il login di Vercel è il token nei Secrets
    const token = process.env.VERCEL_TOKEN ? ` --token ${process.env.VERCEL_TOKEN}` : "";
    const out = execSync(`npx vercel deploy --prod --yes${token}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    deploy = out.match(/https:\/\/canva-bot-risultati-[a-z0-9]+-[a-z0-9]+\.vercel\.app/)?.[0] || "";
  } catch (e: any) {
    ripristina();
    // La voce ripristinata non ha ancora data e ora: se il registro non si rigenera, conta comunque l'errore del deploy
    // (2026-10-28: il registro crollava e nascondeva il motivo del deploy fallito)
    try {
      generaRegistro(leggiReleases());
    } catch {
      /* registro rigenerato alla prossima release */
    }
    ferma(`deploy fallito, niente è cambiato:\n${e.stderr || e.message}`);
  }
  passo(`deploy ${deploy || "(URL non letto)"}`);
  const base = process.env.BASE_URL;
  const avvio: string[] = [];
  for (const [metodo, path] of [["POST", "/api/telegram"], ["GET", "/api/cron-news"], ["GET", "/api/setup"]] as const) {
    const r = await fetch(`${base}${path}`, { method: metodo }).catch(() => null);
    if (r?.status !== 403) avvio.push(`${path}: ${r ? r.status : "nessuna risposta"} (atteso 403)`);
  }
  if (avvio.length) {
    await telegram("sendMessage", { chat_id: process.env.ADMIN_CHAT_ID, text: `🚨 Release ${nuova.versione} pubblicata ma il bot non si avvia:\n${avvio.join("\n")}\n\nEmergenza: promuovi il deploy precedente dal pannello Vercel.` }).catch(() => {});
    ferma(`deploy fatto ma le funzioni non si avviano:\n${avvio.join("\n")}\nEmergenza: promuovere il deploy precedente dal pannello Vercel. Niente commit.`);
  }
  passo("funzioni avviate (403 senza chiave, come previsto)");

  // 4b. Guida aggiornata: PDF nel Generale del gruppo, fissato al posto del precedente (2026-10-20).
  // Prima del commit, così l'id del messaggio fissato entra nel commit.
  if (guidaAggiornata) {
    try {
      const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
      if (!gruppo) throw new Error("nessun gruppo in ALLOWED_CHAT_IDS");
      const cosa = guida.replace(/^aggiornata:\s*/i, "");
      const form = new FormData();
      form.append("chat_id", gruppo); // senza message_thread_id va nel Generale
      form.append("caption", `📘 Guida del bot aggiornata\nNovità: ${cosa}\n\nLa trovi sempre fissata qui in alto.`.slice(0, 1024));
      form.append("document", new Blob([new Uint8Array(readFileSync(FILE_GUIDA_PDF))], { type: "application/pdf" }), `Guida bot social SS Cormano v${nuova.versione}.pdf`);
      const msg = await telegram("sendDocument", form);
      let vecchio: number | undefined;
      try {
        vecchio = JSON.parse(readFileSync(FILE_FISSATA, "utf8")).message_id;
      } catch {
        /* prima volta */
      }
      if (vecchio) await telegram("unpinChatMessage", { chat_id: gruppo, message_id: vecchio }).catch(() => {});
      await telegram("pinChatMessage", { chat_id: gruppo, message_id: msg.message_id, disable_notification: true });
      writeFileSync(FILE_FISSATA, JSON.stringify({ message_id: msg.message_id, versione: nuova.versione }) + "\n");
      passo("guida mandata nel gruppo e fissata");
    } catch (e) {
      console.warn(`⚠️ guida non mandata nel gruppo: ${(e as Error).message}`);
    }
  }

  // 5. Git: commit, tag, push
  const claude = /claude/i.test(nuova.autore) ? "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" : "";
  const messaggio = `release v${nuova.versione}: ${piatto(nuova.gruppo)}\n\nTipo: ${nuova.tipo}\nVerifica: ${piatto(nuova.verifica)}\nDeploy: ${deploy}${claude}`;
  writeFileSync(resolve(ROOT, ".git", "MSG_RELEASE"), messaggio);
  let push = "ok";
  try {
    sh("git add -A");
    sh('git commit -q -F ".git/MSG_RELEASE"');
    sh(`git tag -a v${nuova.versione} -m "v${nuova.versione}"`);
  } catch (e: any) {
    ferma(`deploy fatto, ma commit o tag falliti:\n${e.stderr || e.message}`);
  }
  try {
    sh("git push -q --follow-tags origin HEAD");
  } catch (e: any) {
    push = `NON riuscito (${(e.stderr || e.message).split("\n")[0]})`;
  }
  passo(`git: commit e tag v${nuova.versione}, push ${push}`);

  // 6. Avviso all'admin
  const elencoTg = (v: Testo) => punti(v).map((x) => `• ${x.replace(/\*\*/g, "")}`);
  const testo = [
    `🏷 Release ${nuova.versione} pubblicata (${nuova.tipo})`,
    `${dataIt(nuova.data)}, ${nuova.ora}`,
    "",
    // Un punto per riga anche nel messaggio (2026-10-10), senza asterischi del grassetto
    ...elencoTg(nuova.gruppo),
    "",
    "Verifica:",
    ...elencoTg(nuova.verifica),
    "",
    `📘 Guida: ${guida}`,
    `📒 Manuale: ${manuale}`,
    ...(linkRegistro() ? ["", `Registro e manuale: ${linkRegistro()}`] : []),
    ...(push === "ok" ? [] : ["", `⚠️ Copia su GitHub: ${push}`]),
  ].join("\n");
  try {
    await telegram("sendMessage", { chat_id: process.env.ADMIN_CHAT_ID, text: testo.slice(0, 4000), link_preview_options: { is_disabled: true } });
    passo("avviso inviato all'admin");
  } catch (e) {
    console.warn(`⚠️ avviso Telegram non inviato: ${(e as Error).message}`);
  }
  console.log(`\n✅ Release ${nuova.versione} completata.`);
  const link = linkRegistro();
  console.log(`⚠️ Ora ripubblica docs/registro/index.html sull'Artifact del registro${link ? ` (${link})` : " (link in docs/registro/artifact.txt)"}.`);
})();
