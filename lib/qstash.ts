import crypto from "crypto";

// Firma delle chiamate QStash (header Upstash-Signature, JWT HS256 con le chiavi di firma dell'integrazione Vercel)
export function firmaQstash(jwt: string | null, body: string): boolean {
  const [h, p, s] = (jwt || "").split(".");
  if (!h || !p || !s) return false;
  const firmato = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].some((k) => {
    if (!k) return false;
    const atteso = Buffer.from(crypto.createHmac("sha256", k).update(`${h}.${p}`).digest("base64url"));
    const arrivato = Buffer.from(s);
    return atteso.length === arrivato.length && crypto.timingSafeEqual(atteso, arrivato);
  });
  if (!firmato) return false;
  try {
    const c = JSON.parse(Buffer.from(p, "base64url").toString());
    const ora = Date.now() / 1000;
    if (c.iss !== "Upstash" || !(c.exp > ora) || (c.nbf && c.nbf > ora + 60)) return false;
    // La firma copre anche il corpo (sha256 in base64url, senza "=" finali)
    return String(c.body || "").replace(/=+$/, "") === crypto.createHash("sha256").update(body).digest("base64url");
  } catch {
    return false;
  }
}

// Chiama dest (URL nostro) dopo minuti, una volta sola
export async function programmaChiamata(dest: string, minuti: number) {
  const r = await fetch(`${process.env.QSTASH_URL || "https://qstash.upstash.io"}/v2/publish/${dest}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}`, "Upstash-Delay": `${minuti}m`, "Upstash-Retries": "0" },
  });
  if (!r.ok) throw new Error(`QStash ${r.status}: ${await r.text()}`);
}
