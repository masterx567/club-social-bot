// Gruppo di prova "gruppo di prova" (2026-10-25): qui girano le novità della 3.0 prima del gruppo vero.
// Regole fisse: dal gruppo di prova non esce mai niente sui social e niente entra nella coda vera
// (la coda è una sola per tutti i gruppi), nessuna mail della newsletter.
export const CHAT_PROVA = -1001234567890;

export const inProva = (chat: unknown) => Number(chat) === CHAT_PROVA;

// Novità della 3.0 attive: nel gruppo di prova e, dal lancio del 28/10/2026, nel gruppo vero (quello in ALLOWED_CHAT_IDS).
// Il gruppo di prova resta per provare le novità prima di rilasciarle.
const GRUPPO = Number((process.env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).find((id) => id.startsWith("-")));
export const v3 = (chat: unknown) => inProva(chat) || (!!GRUPPO && Number(chat) === GRUPPO);
