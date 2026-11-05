// Documenti del bot (l'admin 2026-10-26: il paper è diviso in manuale tecnico e registro, il paper per il club sparisce):
//   docs/registro/index.html   pagina per l'Artifact, due schede: Manuale (docs/manuale.md) e Registro (releases.json)
//   docs/guida-bot.html + PDF  guida utenti, invariata
// Niente PDF del registro: si consulta sull'Artifact. Uso diretto: npx tsx scripts/documenti.ts
import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

export type Testo = string | string[];

// Testo di una voce su una riga (messaggio Telegram, commit): punti uniti, niente asterischi
export const piatto = (v?: Testo) => (Array.isArray(v) ? v.join(" ") : v ?? "").replace(/\*\*/g, "");

export interface Release {
  versione: string;
  data: string; // AAAA-MM-GG
  ora?: string;
  tipo: "correzione" | "funzione" | "cambio grosso";
  ricostruita?: boolean;
  // Testo o elenco di punti (dalla 1.0.3 elenco). **parola** = grassetto
  gruppo: Testo;
  tecnico: Testo;
  verifica: Testo;
  ritorno?: Testo;
  autore: string;
  file?: string[]; // file o cartelle toccati dalla release (obbligatorio dalla 1.0.3): il resto non entra
  // Obbligatorio dalla 2.7.0: "aggiornata: cosa cambia per il gruppo" oppure "invariata: perché"
  guida?: string;
  // Obbligatorio dalla 2.19.0: "aggiornato: cosa cambia nel manuale tecnico" oppure "invariato: perché"
  manuale?: string;
}

const DOCS = resolve(__dirname, "..", "docs");
const DIR = join(DOCS, "registro");
export const FILE_RELEASES = join(DIR, "releases.json");
export const FILE_PAGINA = join(DIR, "index.html");
export const FILE_MANUALE = join(DOCS, "manuale.md");
// Link dell'Artifact del registro: lo scrive la sessione che lo pubblica la prima volta
export const FILE_LINK = join(DIR, "artifact.txt");
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

// Date ISO nei testi → "8 ottobre 2026" (niente trattini nei testi)
export const dataIt = (iso: string) => {
  const [a, m, g] = iso.split("-").map(Number);
  return `${g} ${MESI[m - 1]} ${a}`;
};
const conDate = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (x) => dataIt(x));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const testo = (s?: string) => (s ? conDate(esc(s)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") : "");
// Un punto per riga. Le voci vecchie scritte come testo unico vengono divise per frase
export const punti = (v: Testo) =>
  (Array.isArray(v) ? v : v.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú0-9«"(])/)).map((x) => x.trim()).filter(Boolean);
const elenco = (v: Testo) => `<ul>${punti(v).map((x) => `<li>${testo(x)}</li>`).join("")}</ul>`;

export const leggiReleases = (): Release[] => JSON.parse(readFileSync(FILE_RELEASES, "utf8"));
export const linkRegistro = () => (existsSync(FILE_LINK) ? readFileSync(FILE_LINK, "utf8").trim() : "");

// Voce del registro: chiusa su una riga (versione, tipo, data, cosa cambia), si apre con un tocco
function voce(r: Release): string {
  const classe = r.tipo === "cambio grosso" ? "grosso" : r.tipo;
  const riga = (k: string, v?: Testo) => (v && v.length ? `<dt>${k}</dt><dd>${elenco(v)}</dd>` : "");
  const breve = (k: string, v?: string) => (v ? `<dt>${k}</dt><dd>${testo(v)}</dd>` : "");
  const cerca = esc(`${r.versione} ${r.tipo} ${piatto(r.gruppo)} ${piatto(r.tecnico)} ${(r.file || []).join(" ")}`.toLowerCase());
  return `<details class="release" id="v${r.versione}" data-tipo="${classe}" data-cerca="${cerca}">
  <summary><span class="v">${r.versione}</span><span class="tipo ${classe}">${r.tipo}</span><span class="d">${dataIt(r.data)}${r.ora ? `, ${r.ora}` : ""}</span><span class="cosa">${testo(piatto(r.gruppo))}</span></summary>
  <dl>${riga("Cosa cambia per il gruppo", r.gruppo)}${riga("Cosa si è modificato", r.tecnico)}${riga("Come è stato provato", r.verifica)}${riga("Come tornare indietro", r.ritorno)}${breve("Guida", r.guida)}${breve("Manuale", r.manuale)}${breve("Autore", r.autore)}${breve("File", r.file?.join(", "))}${r.ricostruita ? "<dt>Nota</dt><dd>Voce ricostruita dal diario, scritta prima che le release esistessero.</dd>" : ""}</dl>
</details>`;
}

// Markdown del manuale → HTML. Basta quello che il manuale usa: titoli, paragrafi, elenchi, tabelle, `codice`, **grassetto**
export function markdown(md: string): string {
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const righe = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < righe.length) {
    const r = righe[i];
    if (!r.trim()) {
      i++;
      continue;
    }
    const h = r.match(/^(#{1,3}) (.+)$/);
    if (h) {
      const livello = h[1].length;
      const id = h[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
      out.push(livello === 1 ? "" : `<h${livello} id="m-${id}">${inline(h[2])}</h${livello}>`);
      i++;
      continue;
    }
    if (r.startsWith("|")) {
      const tab: string[] = [];
      while (i < righe.length && righe[i].startsWith("|")) tab.push(righe[i++]);
      const celle = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [testa, , ...corpo] = tab;
      out.push(`<div class="tabella"><table><tr>${celle(testa).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${corpo.map((l) => `<tr>${celle(l).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table></div>`);
      continue;
    }
    const lista = r.match(/^(\s*)(-|\d+\.) /);
    if (lista) {
      const ordinata = /\d/.test(lista[2]);
      const voci: string[] = [];
      while (i < righe.length && /^\s*(-|\d+\.) /.test(righe[i])) voci.push(righe[i++].replace(/^\s*(-|\d+\.) /, ""));
      out.push(`<${ordinata ? "ol" : "ul"}>${voci.map((v) => `<li>${inline(v)}</li>`).join("")}</${ordinata ? "ol" : "ul"}>`);
      continue;
    }
    const par: string[] = [];
    while (i < righe.length && righe[i].trim() && !/^(#|\||\s*(-|\d+\.) )/.test(righe[i])) par.push(righe[i++]);
    out.push(`<p>${inline(par.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function generaRegistro(releases = leggiReleases()): string {
  const ultima = releases[releases.length - 1];
  const stile = readFileSync(join(DOCS, "stile.html"), "utf8");
  const logo = readFileSync(join(DOCS, "logo-lv.png")).toString("base64");
  const manuale = markdown(readFileSync(FILE_MANUALE, "utf8"));
  const indice = [...readFileSync(FILE_MANUALE, "utf8").matchAll(/^## (.+)$/gm)].map((m) => {
    const id = m[1].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    return `<li><a href="#m-${id}">${esc(m[1].replace(/^\d+\.\s*/, ""))}</a></li>`;
  });
  const html = `<title>Registro Bot Social</title>
${stile}
<style>
.schede { display: flex; gap: 8px; margin: 22px 0 6px; }
.schede button { font: 700 15px/1 var(--display); padding: 10px 18px; border-radius: 999px; border: 2px solid var(--bordo); background: var(--foglio); color: var(--inchiostro); cursor: pointer; }
.schede button[aria-selected="true"] { background: var(--verde); border-color: var(--verde); color: #fff; }
.schede button:focus-visible { outline: 3px solid var(--oro); outline-offset: 2px; }
.filtri { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }
.filtri input, .filtri select { font: 15px var(--testo); padding: 9px 12px; border-radius: 10px; border: 1.5px solid var(--bordo); background: var(--foglio); color: var(--inchiostro); }
.filtri input { flex: 1 1 220px; min-width: 0; }
.release summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; cursor: pointer; list-style: none; }
.release summary::-webkit-details-marker { display: none; }
.release summary .cosa { flex: 1 1 100%; font-size: 14px; line-height: 1.4; }
.release[open] summary { margin-bottom: 6px; }
.conta { color: var(--tenue); font-size: 14px; }
#manuale h2 { margin-top: 30px; }
#manuale h3 { margin-top: 18px; }
main code { word-break: break-word; }
</style>
<header class="copertina">
  <div class="dentro">
    <div class="logo"><img src="data:image/png;base64,${logo}" alt="Logo C.S. SS Cormano"></div>
    <div class="occhiello">SS Cormano ASD-APS · Bot social</div>
    <h1>Manuale e registro</h1>
    <div class="meta"><span>Versione <b>${ultima.versione}</b></span><span>Aggiornato al <b>${dataIt(ultima.data)}</b></span><span><b>${releases.length}</b> release</span></div>
  </div>
</header>
<div class="striscia" aria-hidden="true"></div>
<main class="pagina">
  <div class="schede" role="tablist">
    <button role="tab" id="t-registro" aria-selected="true" aria-controls="registro">Registro</button>
    <button role="tab" id="t-manuale" aria-selected="false" aria-controls="manuale">Manuale</button>
  </div>
  <section id="registro" role="tabpanel" aria-labelledby="t-registro">
    <div class="filtri">
      <label class="nota" for="cerca" hidden>Cerca</label>
      <input id="cerca" type="search" placeholder="Cerca: newsletter, logo, 2.18…">
      <select id="tipo" aria-label="Tipo"><option value="">Tutti i tipi</option><option value="funzione">Funzioni</option><option value="correzione">Correzioni</option><option value="grosso">Cambi grossi</option></select>
    </div>
    <p class="conta" id="conta"></p>
    ${[...releases].reverse().map(voce).join("\n")}
  </section>
  <section id="manuale" role="tabpanel" aria-labelledby="t-manuale" hidden>
    <nav class="indice" aria-label="Indice del manuale"><b>Indice</b><ol>${indice.join("")}</ol></nav>
    ${manuale}
  </section>
</main>
<script>
(() => {
  const tab = (nome) => {
    for (const s of ["registro", "manuale"]) {
      document.getElementById(s).hidden = s !== nome;
      document.getElementById("t-" + s).setAttribute("aria-selected", String(s === nome));
    }
  };
  document.getElementById("t-registro").onclick = () => tab("registro");
  document.getElementById("t-manuale").onclick = () => tab("manuale");
  if (/^#m-/.test(location.hash) || location.hash === "#manuale") tab("manuale");
  const voci = [...document.querySelectorAll(".release")];
  const filtra = () => {
    const q = document.getElementById("cerca").value.trim().toLowerCase();
    const t = document.getElementById("tipo").value;
    let n = 0;
    for (const v of voci) {
      const ok = (!q || v.dataset.cerca.includes(q)) && (!t || v.dataset.tipo === t);
      v.hidden = !ok;
      if (ok) n++;
    }
    document.getElementById("conta").textContent = n + " release su " + voci.length;
  };
  document.getElementById("cerca").oninput = filtra;
  document.getElementById("tipo").onchange = filtra;
  filtra();
})();
</script>`;
  writeFileSync(FILE_PAGINA, html);
  return FILE_PAGINA;
}

// Chrome o Edge in locale, per il PDF della guida. Su GitHub Actions (rilascio.yml, Ubuntu) c'è google-chrome.
function browser(): string {
  const candidati = [
    process.env.CHROME_PATH || "",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  const b = candidati.find((p) => existsSync(p));
  if (!b) throw new Error("Né Chrome né Edge trovati: serve uno dei due per il PDF");
  return b;
}

// Stampa una pagina in PDF, in tema chiaro. pagina = regola @page di base (le pagine con nome, es. orizzontale, restano)
function stampaPdf(html: string, pdf: string, pagina: string) {
  const stampa = join(DOCS, ".stampa.html");
  writeFileSync(
    stampa,
    `<!doctype html><html lang="it" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${pagina}</style></head><body>${html}</body></html>`,
  );
  rmSync(pdf, { force: true }); // un PDF vecchio non deve passare per nuovo
  try {
    execFileSync(browser(), ["--headless=new", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--no-pdf-header-footer", "--virtual-time-budget=10000", `--print-to-pdf=${pdf}`, pathToFileURL(stampa).href], { stdio: "ignore" });
  } finally {
    rmSync(stampa, { force: true });
  }
  if (!existsSync(pdf)) throw new Error(`PDF non generato: ${pdf}`);
}

// Guida utenti (docs/guida-bot.src.html): pagina per l'Artifact e PDF A5 da fissare nel gruppo Telegram.
export const FILE_GUIDA_PDF = join(DOCS, "Guida bot social SS Cormano.pdf");
export function generaGuida(): { html: string; pdf: string } {
  const logo = readFileSync(join(DOCS, "logo-lv.png")).toString("base64");
  const html = readFileSync(join(DOCS, "guida-bot.src.html"), "utf8").replace("__LOGO__", logo);
  const out = join(DOCS, "guida-bot.html");
  writeFileSync(out, html);
  stampaPdf(html, FILE_GUIDA_PDF, "@page{size:A4;margin:8mm 0}"); // 3.0: guida di una pagina A4 (prima A5, una sezione per foglio)
  return { html: out, pdf: FILE_GUIDA_PDF };
}

if (require.main === module) {
  console.log(`Registro generato: ${generaRegistro()}`);
}
