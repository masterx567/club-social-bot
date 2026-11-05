import sharp from "sharp";

// Controlli prima della pubblicazione automatica su Instagram.
// Lista vuota = si può pubblicare da soli (dopo la finestra di annullamento).
// Qualsiasi problema, o controllo non eseguibile, = serve un ✅ di una persona.

// Segnaposto dei template rimasti nel testo: autofill non arrivato
const SEGNAPOSTO = /\bXX\s*[-–]\s*XX\b|\bSQUADRA [AB]\b|\bNOME CATEGORIA\b/i;

const MODELLO = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

// 2026-10-18: il modello segnalava testi "tagliati" su copertine perfette (RISULTATO, punteggio, #SEMPRE INSIEME).
// I testi della grafica li scrive il bot nel template: all'AI resta solo la foto e il segnaposto rimasto.
const PROMPT = `Controlla una grafica social di una società sportiva prima della pubblicazione.
La grafica è un modello fisso: titoli, nomi, punteggio, scritte e loghi sono già corretti, anche se in corsivo, inclinati o vicini al bordo. Non giudicarli.
Segnala SOLO questi problemi, e solo se sei sicuro:
- testo segnaposto rimasto, esattamente "XX - XX", "SQUADRA A", "SQUADRA B", "NOME CATEGORIA" o "LOREM"
- una persona con la testa tagliata dal bordo della foto
- foto mancante, nera o completamente sfocata
Nel dubbio non segnalare. Rispondi solo JSON: {"problemi": ["frase breve in italiano", ...]} con lista vuota se è tutto ok.`;

async function controllaImmagine(img: Buffer): Promise<string[]> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return ["controllo AI non disponibile (manca la chiave Groq)"];
  const piccola = await sharp(img).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const corpo = JSON.stringify({
    model: MODELLO,
    temperature: 0,
    max_completion_tokens: 120, // limite gratuito Groq: 1000 token di risposta al minuto
    reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${piccola.toString("base64")}` } },
        ],
      },
    ],
  });
  // Fino a 3 tentativi con 20s di pausa: il piano gratuito Groq dà 429 se arrivano tante slide insieme
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: corpo,
      });
      if (r.status === 429 && tentativo < 2) {
        await new Promise((ok) => setTimeout(ok, 20000));
        continue;
      }
      if (!r.ok) throw new Error(`Groq ${r.status}`);
      const j = await r.json();
      const { problemi } = JSON.parse(j.choices[0].message.content);
      return Array.isArray(problemi) ? problemi.map(String).filter(Boolean) : ["risposta del controllo AI non valida"];
    } catch (e) {
      if (tentativo === 2) return [`controllo AI non riuscito (${(e as Error).message})`];
    }
  }
  return ["controllo AI non riuscito"];
}

export async function controllaPost(imgs: Buffer[], caption: string): Promise<string[]> {
  const problemi: string[] = [];
  if (SEGNAPOSTO.test(caption)) problemi.push("nella didascalia c'è un testo segnaposto");
  for (const [i, img] of imgs.entries()) {
    const p = await controllaImmagine(img);
    problemi.push(...p.map((x) => (imgs.length > 1 ? `slide ${i + 1}: ${x}` : x)));
  }
  return problemi;
}
