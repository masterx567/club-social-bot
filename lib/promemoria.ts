import { idArgomento, nelThread } from "./argomenti";
import { aggiornaPartite, isoOggi } from "./carosello";
import { categoriaDi, nomeGrafica, partiteTra, type Partita } from "./partite";
import { schede } from "./registro";
import { redis } from "./store";
import { tg } from "./telegram";

// 3.0 (2026-10-28): lunedì alle 20, prima del carosello di martedì, avviso in ✍️ Post manuali per le partite
// della settimana senza post risultato. Era successo: un risultato dimenticato, uscito solo nel carosello.
// Partite = SS Cormano da martedì a domenica (ultimi 6 giorni, oggi escluso), non rinviate, con categoria nota.
// Fatta = un post risultato o amichevole della stessa categoria, pubblicato (registro) o con ✅ (in coda o, in prova,
// "🧪 PROVA"), uscito dal giorno della partita. Per categoria e non per partita: vale anche ➕ Altra partita.
// Il torneo no (3.7.0): dice solo che abbiamo partecipato, non copre una partita.
// Niente da segnalare = nessun messaggio.

const ggmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// Post con ✅ ancora non usciti: iglock:<id> c'è (coda o prova) e la scheda è dentro i 7 giorni dei bottoni
async function conSpunta(chatId: number): Promise<{ categoria?: string; ms: number }[]> {
  const out: { categoria?: string; ms: number }[] = [];
  let cur = "0";
  const ids = new Set<string>();
  do {
    const [c, k] = await redis.scan(cur, { match: `igcover:${chatId}:*`, count: 500 });
    cur = String(c);
    for (const x of k as string[]) {
      const id = await redis.get<string>(x);
      if (id) ids.add(id);
    }
  } while (cur !== "0");
  for (const id of ids) {
    const [p, lock, ts] = await Promise.all([
      redis.get<{ tipo?: string; categoria?: string }>(`igpost:${id}`),
      redis.exists(`iglock:${id}`),
      redis.get<number>(`igcodats:${id}`),
    ]);
    if (p && lock && (p.tipo === "risultato" || p.tipo === "amichevole")) out.push({ categoria: p.categoria, ms: ts || Date.now() });
  }
  return out;
}

export async function risultatiMancanti(chatId: number, adesso = new Date()): Promise<Partita[]> {
  const giorno = (n: number) => isoOggi(new Date(adesso.getTime() - n * 86_400_000));
  const da = giorno(6);
  const a = giorno(1);
  await aggiornaPartite().catch(() => {}); // portali giù: si usa quello che c'è
  const partite = (await partiteTra(da, a)).filter((p) => p.stato !== "rinviata" && categoriaDi(p) && /linea\s*verde/i.test(`${p.casa} ${p.ospite}`));
  const inizio = new Date(`${da}T00:00:00+01:00`).getTime() - 3_600_000; // margine per l'ora legale
  const fatti = [
    ...(await schede(inizio, adesso.getTime())).filter((s) => s.tipo === "risultato" || s.tipo === "amichevole").map((s) => ({ categoria: s.categoria, ms: s.uscito })),
    ...(await conSpunta(chatId)),
  ];
  // Per categoria: le partite più vecchie si coprono per prime, restano scoperte le altre
  const mancanti: Partita[] = [];
  const perCategoria = new Map<string, Partita[]>();
  for (const p of partite) {
    const c = categoriaDi(p)!.etichetta;
    perCategoria.set(c, [...(perCategoria.get(c) || []), p]);
  }
  for (const [c, ps] of perCategoria) {
    ps.sort((x, y) => x.data.localeCompare(y.data));
    const coperti = fatti.filter((f) => f.categoria === c && isoOggi(new Date(f.ms)) >= ps[0].data).length;
    mancanti.push(...ps.slice(coperti));
  }
  return mancanti.sort((x, y) => x.data.localeCompare(y.data));
}

// Ritorna quante partite mancano (0 = nessun messaggio)
export async function promemoriaRisultati(chatId: number): Promise<number> {
  const mancanti = await risultatiMancanti(chatId);
  if (!mancanti.length) return 0;
  // Nome dell'avversario come in grafica (alias approvati o nome ripulito): sul portale ci sono sigle e caratteri strani
  const righe = await Promise.all(
    mancanti.map(async (p) => {
      const portale = (/linea\s*verde/i.test(p.casa) ? p.ospite : p.casa).replace(/&#x27;|&#0?39;/g, "'");
      const avv = await nomeGrafica(portale).catch(() => portale);
      return `• ${categoriaDi(p)!.etichetta} contro ${avv} (${ggmm(p.data)})`;
    }),
  );
  const testo = `⏰ ${mancanti.length === 1 ? "Manca 1 risultato" : `Mancano ${mancanti.length} risultati`} della settimana:\n${righe.join("\n")}\n\nMartedì alle 9 escono nel carosello: se avete una foto, mandatela qui e toccate 🏆 Risultato.`;
  await nelThread(await idArgomento("manuali", chatId), () => tg("sendMessage", { chat_id: chatId, text: testo }));
  return mancanti.length;
}
