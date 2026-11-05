import { nellArgomento } from "../lib/argomenti";
import { pubblicaNuove } from "../lib/news-csi";
import { avvisaAdmin } from "../lib/telegram";
import { inviaReport, reportMensile } from "../lib/metriche";
import { rinnovaToken } from "../lib/instagram";
import { finestra, inviaPeriodo, type Periodo } from "../lib/report";
import { v3 } from "../lib/prova";

// Cron Vercel giornaliero (vercel.json): notizie nuove della home CSI Milano nel gruppo, da rilanciare.
// Vercel firma la chiamata con "Authorization: Bearer CRON_SECRET".
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  // Il gruppo è l'unico ID negativo in ALLOWED_CHAT_IDS (gli ID privati sono positivi)
  const gruppo = (process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-"));
  if (!gruppo) return new Response("nessun gruppo in ALLOWED_CHAT_IDS", { status: 500 });

  await rinnovaToken(); // token Instagram: sfrutta il cron giornaliero, gli errori li gestisce da sé

  // Il 1° del mese: report statistiche del mese precedente nell'argomento 📊 (sfrutta questo cron, niente funzione in più)
  const giornoRoma = Number(new Date().toLocaleDateString("it-IT", { day: "numeric", timeZone: "Europe/Rome" }));
  if (giornoRoma === 1 && v3(Number(gruppo))) {
    // 3.0: mese chiuso e, se chiudono oggi, trimestre, semestre e stagione (settembre-agosto), in fila (lib/report.ts)
    for (const tipo of ["mese", "trimestre", "semestre", "stagione"] as Periodo[]) {
      const f = finestra(tipo, new Date(), true);
      if (!f) continue;
      try {
        const errori = await nellArgomento("statistiche", () => inviaPeriodo(Number(gruppo), f));
        if (errori.length) await avvisaAdmin(`⚠️ Report ${f.nome}, metriche non lette:\n${errori.join("\n")}`);
      } catch (e) {
        await avvisaAdmin(`Report ${f.nome} fallito: ${(e as Error).message}`);
      }
    }
  } else if (giornoRoma === 1) {
    try {
      const r = await reportMensile();
      await nellArgomento("statistiche", () => inviaReport(Number(gruppo), r));
      if (r.errori.length) await avvisaAdmin(`⚠️ Report mensile, metriche non lette:\n${r.errori.join("\n")}`);
    } catch (e) {
      await avvisaAdmin(`Report mensile fallito: ${(e as Error).message}`);
    }
  }
  try {
    const n = await nellArgomento("csi", () => pubblicaNuove(Number(gruppo)));
    return new Response(`ok, ${n} nuove`);
  } catch (e) {
    console.error("cron news", e); // anche nei log Vercel: prima si vedeva solo il 500
    await avvisaAdmin(`Cron news CSI fallito: ${(e as Error).message}`);
    return new Response("errore", { status: 500 });
  }
}
