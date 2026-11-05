// Sport -> categorie. Aggiungere una categoria = una riga.
// Il testo in grafica è "CATEGORIA · SPORT" (vedi etichetta()).
export const SPORT: Record<string, string[]> = {
  GIOCASPORT: ["GIOCASPORT"],
  CALCIO: ["BIG SMALL", "UNDER 9", "OPEN ECCELLENZA"],
  VOLLEY: ["MINIVOLLEY", "UNDER 10", "UNDER 13", "UNDER 14", "UNDER 17"],
  BASKET: [
    "SCUOLA BASKET",
    "UNDER 10",
    "UNDER 12",
    "UNDER 14",
    "UNDER 15",
    "UNDER 16 FEMM.",
    "UNDER 17",
    "DR2",
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Parole normalizzate: "femminile"/"f" -> "femm", "u14" -> "under 14"
const parole = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((p) => {
      if (/^(femminile|femm|f)$/.test(p)) return ["femm"];
      const u = p.match(/^u(\d+)$/);
      return u ? ["under", u[1]] : [p];
    });

// La categoria c'è se ci sono tutte le sue parole, in qualunque ordine
// ("UNDER 16 BASKET FEMMINILE" -> UNDER 16 FEMM.), ma "under N" deve essere attaccato:
// così il numero di un punteggio non viene scambiato per una categoria.
function contieneCategoria(testo: string[], categoria: string): boolean {
  const cat = parole(categoria);
  if (!cat.every((p) => testo.includes(p))) return false;
  const n = cat.indexOf("under");
  if (n < 0) return true;
  return testo.some((p, i) => p === "under" && testo[i + 1] === cat[n + 1]);
}

// Riconosce sport/categoria scritti a mano nella didascalia ("Calcio - Open eccellenza").
// Categoria: vince la più lunga contenuta nel testo ("under 16 femm" batte "under 1…").
export function riconosci(testo: string): { sport?: string; categoria?: string } {
  const t = norm(testo);
  const tp = parole(testo);
  const cercaCategoria = (sport: string) =>
    SPORT[sport].filter((c) => contieneCategoria(tp, c)).sort((a, b) => parole(b).length - parole(a).length)[0];

  const sport = Object.keys(SPORT).find((s) => t.includes(norm(s)));
  if (sport) return { sport, categoria: cercaCategoria(sport) };

  // Sport non scritto: va bene solo se la categoria esiste in un solo sport
  const trovate = Object.keys(SPORT).map((s) => ({ sport: s, categoria: cercaCategoria(s) })).filter((x) => x.categoria);
  return trovate.length === 1 ? trovate[0] : {};
}

export function etichetta(sport: string, categoria: string): string {
  // "GIOCASPORT", "MINIVOLLEY", "SCUOLA BASKET" contengono già lo sport: niente doppione
  if (categoria.includes(sport) || categoria === "MINIVOLLEY") return categoria;
  return `${categoria} · ${sport}`;
}
