import type { Tipo } from "./pipeline";

// Instagram: gli hashtag in fondo alla didascalia vanno nel primo commento (Issue 6)
// Si spostano solo le ultime righe fatte di soli hashtag; se resterebbe una didascalia vuota, non si tocca niente.
export function dividiHashtag(caption: string): { testo: string; hashtag: string } {
  const righe = caption.trimEnd().split("\n");
  const tag: string[] = [];
  while (righe.length && /^\s*(#[\p{L}\p{N}_]+\s*)+$/u.test(righe[righe.length - 1])) tag.unshift(righe.pop()!.trim());
  const testo = righe.join("\n").trimEnd();
  return testo ? { testo, hashtag: tag.join(" ") } : { testo: caption, hashtag: "" };
}

// Testo alternativo della grafica, per chi usa lo screen reader. Instagram ne accetta fino a 1000 caratteri.
export function testoAlternativo(r: { tipo: Tipo; categoria: string; risultato: string; squadraA: string; squadraB: string }): string {
  const cat = r.categoria.replace(/\s*·\s*/g, " ").toLowerCase();
  if (r.tipo === "torneo") return `Grafica SS Cormano: ${cat} al torneo organizzato da ${r.squadraB}.`;
  const p = r.risultato.match(/(\d+)\s*[-–]\s*(\d+)/);
  const punti = p ? `${p[1]} a ${p[2]}` : r.risultato;
  const nome = r.tipo === "amichevole" ? "Amichevole" : "Risultato";
  return `${nome} ${cat}: ${r.squadraA} ${punti} ${r.squadraB}.`.slice(0, 1000);
}
