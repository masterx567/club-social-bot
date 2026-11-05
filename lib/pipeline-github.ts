import { tg } from "./telegram";
// Pipeline degli aggiornamenti (2026-10-29): bottoni nei messaggi privati all'admin che mettono un'etichetta su GitHub.
//   "gh:scelta:<Issue>"  → etichetta "scelta" sulla Issue: parte il workflow Lavoro (codice, PR, prova)
//   "gh:rilascia:<PR>"   → etichetta "rilascia" sulla PR provata: parte il workflow Rilascio (npm run release)
// Solo l'admin (ADMIN_CHAT_ID) nella sua chat privata. GH_PIPELINE_TOKEN è un token GitHub dell'admin, solo Issue e PR
// di questo repository: un'etichetta messa con il suo token fa partire i workflow e passa il controllo del rilascio.
const REPO = process.env.GITHUB_REPO || "tuo-utente/tuo-repo";
const FATTO = { scelta: "✅ Scelta: Claude la sviluppa e la prova", rilascia: "🚀 Rilascio avviato: tra pochi minuti arriva l'avviso" } as const;

export async function suBottonePipeline(q: any) {
  const [, etichetta, numero] = String(q.data).split(":");
  const admin = String(process.env.ADMIN_CHAT_ID);
  if (String(q.from.id) !== admin || String(q.message?.chat.id) !== admin || !(etichetta in FATTO) || !/^\d+$/.test(numero)) {
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "Solo l'admin può usare questo bottone", show_alert: true });
    return;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/issues/${numero}/labels`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GH_PIPELINE_TOKEN}`, Accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ labels: [etichetta] }),
  });
  if (!r.ok) {
    console.error(`GitHub etichetta ${etichetta} su #${numero}: ${r.status} ${await r.text()}`);
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: `GitHub non ha accettato (${r.status}). Metti l'etichetta «${etichetta}» a mano su #${numero}.`, show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: FATTO[etichetta as keyof typeof FATTO] });
  // Tolto il bottone toccato, restano gli altri (le idee sono più di una nello stesso messaggio)
  const righe = (q.message.reply_markup?.inline_keyboard || []).map((r: any[]) => r.filter((b) => b.callback_data !== q.data)).filter((r: any[]) => r.length);
  await tg("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: righe } }).catch(() => {});
  await tg("sendMessage", { chat_id: q.message.chat.id, text: `${FATTO[etichetta as keyof typeof FATTO]} (#${numero})`, reply_parameters: { message_id: q.message.message_id, allow_sending_without_reply: true } });
}
