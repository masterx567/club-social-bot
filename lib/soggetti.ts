import sharp from "sharp";

// Chiede a un modello vision (Groq) la fascia verticale dove stanno le persone,
// in percentuale dell'altezza della foto. Serve al ritaglio per lasciare fuori
// canestro, muro vuoto, cielo. Se manca la chiave o qualcosa va storto: null,
// e il ritaglio usa la regola fissa.
// llama-4-scout ritirato da Groq (404, 2026-10-05): qwen3.8 legge immagini, testato su foto U14
const MODELLO = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

export interface Box {
  top: number; // 0..1
  bottom: number;
  left: number;
  right: number;
}

// Riquadro che contiene tutte le persone: serve per le foto aggiunte ai caroselli manuali,
// ritagliate al 4:5 anche ai lati (le orizzontali). null = non trovato, si ritaglia al centro.
export async function boxPersone(img: Buffer): Promise<Box | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const piccola = await sharp(img).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    // Album di molte foto = molte richieste insieme: Groq gratuito risponde 429, si aspetta quanto dice e si riprova
    const chiama = () => fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: MODELLO,
        temperature: 0,
        max_completion_tokens: 60,
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  'Foto sportiva. Trova il riquadro che contiene TUTTE le persone (teste comprese). Rispondi solo JSON: {"top":<0-100>,"bottom":<0-100>,"left":<0-100>,"right":<0-100>} in percentuale di altezza (top/bottom) e larghezza (left/right), 0 = bordo alto/sinistro.',
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${piccola.toString("base64")}` } },
            ],
          },
        ],
      }),
    });
    let r = await chiama();
    for (let i = 0; i < 3 && r.status === 429; i++) {
      await new Promise((ok) => setTimeout(ok, Math.min(Number(r.headers.get("retry-after")) || 5, 15) * 1000));
      r = await chiama();
    }
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const j = await r.json();
    const b = JSON.parse(j.choices[0].message.content);
    const box = { top: b.top / 100, bottom: b.bottom / 100, left: b.left / 100, right: b.right / 100 };
    const ok = [box.top, box.bottom, box.left, box.right].every((v) => v >= 0 && v <= 1) && box.bottom - box.top > 0.05 && box.right - box.left > 0.05;
    return ok ? box : null;
  } catch (e) {
    console.error("boxPersone", e);
    return null;
  }
}

export interface Fascia {
  top: number; // 0..1
  bottom: number; // 0..1
}

// volti: fascia dei soli volti (eventi, l'admin 2026-10-24: foto di persone in posa, conta che le facce entrino)
export async function fasciaPersone(img: Buffer, volti = false): Promise<Fascia | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const piccola = await sharp(img).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model: MODELLO,
        temperature: 0,
        // Tetto basso: senza, Groq riserva il massimo e sfora il limite gratuito di 1000 token/minuto (429)
        max_completion_tokens: 60,
        reasoning_effort: "none",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: volti
                  ? 'Foto di persone. Trova la fascia orizzontale che contiene TUTTI i volti, dalla cima della testa più alta al mento più basso. Rispondi solo JSON: {"top": <0-100>, "bottom": <0-100>} in percentuale dell\x27altezza della foto, 0 = bordo alto.'
                  :
                  'Foto di una squadra sportiva. Trova la fascia orizzontale che contiene TUTTE le persone, dalla testa più alta ai piedi più bassi (anche chi è seduto o sdraiato). Rispondi solo JSON: {"top": <0-100>, "bottom": <0-100>} in percentuale dell\'altezza della foto, 0 = bordo alto.',
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${piccola.toString("base64")}` } },
            ],
          },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const { top, bottom } = JSON.parse(j.choices[0].message.content);
    const t = Number(top) / 100;
    const b = Number(bottom) / 100;
    if (!(t >= 0 && b <= 1 && b - t > (volti ? 0.02 : 0.1))) return null; // risposta assurda: ignorata
    return { top: t, bottom: b };
  } catch (e) {
    console.error("fasciaPersone", e);
    return null;
  }
}
