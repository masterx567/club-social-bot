import dns from "node:dns";
import type { Partita } from "../partite";

// Node in locale prova IPv6 e va in timeout sul server CSI; su Vercel non cambia nulla
dns.setDefaultResultOrder("ipv4first");

const URL_FILTRI = "https://www.csi.milano.it/public/ajax/filtri.php";
const SOCIETA = process.env.CSI_SOCIETA || "0000"; // codice società nell'albo CSI Milano

async function filtri(body: Record<string, string>): Promise<string> {
  const r = await fetch(URL_FILTRI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`CSI ${r.status} su ${body.propertyMethod || "risultati"}`);
  return r.text();
}

// I filtri a cascata dell'albo: dato un contesto, restituiscono una lista <a id="...">nome</a>
async function lista(metodo: string, cambiato: string, valore: string, contesto: string) {
  const html = await filtri({
    propertyBiz: "albo",
    propertyBizChanged: cambiato,
    propertyBizChangedValue: valore,
    propertyBizKeyValue: contesto,
    propertyMethod: metodo,
    propertyViewList: "filter_box",
  });
  return [...html.matchAll(/id="([^"]+)"[^>]*>\s*([^<]+?)\s*</g)]
    .map((m) => ({ id: m[1], nome: m[2].trim() }))
    .filter((x) => x.nome !== "RIMUOVI");
}

const pulisci = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// "24/09/2026" -> "2026-09-24"
const isoData = (s: string) => {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
};

const BASE = "https://www.csi.milano.it";

// Celle di una riga per classe: "squadra", "data", "ora", "codice", "punteggio"...
const celle = (tr: string, classe: string) =>
  [...tr.matchAll(new RegExp(`<td[^>]*class="${classe}"[^>]*>([\\s\\S]*?)</td>`, "gi"))].map((m) => m[1]);
// Loghi società nell'ordine delle squadre della riga
const loghi = (tr: string) =>
  [...tr.matchAll(/<td[^>]*class="logo-squadra"[^>]*>\s*<img src="([^"?]+)/gi)].map((m) => `${BASE}${m[1]}`);

// Due formati nella stessa pagina:
// - calcio: una riga con casa e ospite, punteggio "5 - 1" in td.punteggio dopo il codice
// - pallavolo: riga casa (con data/ora/codice in rowspan=2) + riga sotto con la sola squadra ospite
// Esportata per i test su HTML salvato.
export function leggiGareCsi(html: string, campionato: string, campionatoNome: string): Partita[] {
  const trs = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const out: Partita[] = [];
  trs.forEach((tr, i) => {
    const codice = pulisci(celle(tr, "codice")[0] || "");
    // codice gara, es. 2026113AA0205; i giovanili basket hanno cifra+lettera: 20265221A0101
    // (con [A-Z]{2} le gare U10/U12 basket venivano scartate tutte, 2026-10-08)
    if (!/^\d{5,}[A-Z0-9]{2}\d{4}$/.test(codice)) return;
    let squadre = celle(tr, "squadra").map(pulisci);
    let logo = loghi(tr);
    let esito = celle(tr, "punteggio").map(pulisci).join(" ");
    if (squadre.length === 1 && trs[i + 1]) {
      // pallavolo: l'ospite è nella riga sotto (con i suoi set, se la gara è giocata)
      squadre = [squadre[0], ...celle(trs[i + 1], "squadra").map(pulisci)];
      logo = [...logo, ...loghi(trs[i + 1])];
      const sotto = pulisci(trs[i + 1].replace(/<td[^>]*class="(logo-)?squadra"[\s\S]*?<\/td>/gi, ""));
      const su = esito.match(/\d+/)?.[0];
      const giu = sotto.match(/\d+/)?.[0];
      esito = su && giu ? `${su} - ${giu}` : esito;
    }
    const [casa, ospite] = squadre;
    if (!casa || !ospite || !/ss cormano/i.test(`${casa} ${ospite}`)) return;
    const punti = esito.match(/(\d+)\s*-\s*(\d+)/);

    out.push({
      id: `csi:${codice}`,
      ente: "CSI",
      campionato,
      campionatoNome,
      data: isoData(pulisci(celle(tr, "data")[0] || "")),
      ora: pulisci(celle(tr, "ora")[0] || "").match(/\d{2}:\d{2}/)?.[0] || "",
      casa,
      ospite,
      logoCasa: logo[0],
      logoOspite: logo[1],
      pc: punti ? Number(punti[1]) : undefined,
      po: punti ? Number(punti[2]) : undefined,
      // "REC." = recupero: gara già rispostata a una data nuova, si gioca (S.C. United 28/10, 2026-10-27: prima era
      // contata come rinviata e restava fuori dalle partite della settimana). Rinviata solo "RINV." (data ancora da fissare)
      stato: punti ? "giocata" : /rinv/i.test(esito) ? "rinviata" : "da_giocare",
    });
  });
  return out;
}

// Tutte le partite SS CORMANO della stagione, da tutti i campionati in cui la società è iscritta.
// Nessuna lista campionati scritta a mano: una squadra nuova entra da sola.
export async function partiteCsi(): Promise<Partita[]> {
  const campionati = await lista("campionati_per_filtro", "societa", SOCIETA, `societa=${SOCIETA}`);
  const out: Partita[] = [];

  for (const c of campionati) {
    const gironi = await lista("gironi_per_filtro", "campionato", c.id, `societa=${SOCIETA}&campionato=${c.id}`);
    for (const g of gironi.length ? gironi : [{ id: "", nome: "" }]) {
      const html = await filtri({ albo: "ok", risultati: "ok", campionato: c.id, squadra: "", girone: g.id });
      out.push(...leggiGareCsi(html, c.id, c.nome));
    }
  }
  return out;
}
