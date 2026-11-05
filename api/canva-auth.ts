import crypto from "crypto";
import { redis } from "../lib/store";
import { SCOPES } from "../lib/canva";

// Avvio login Canva (una tantum, o se il token si perde). Protetto da SETUP_SECRET.
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== process.env.SETUP_SECRET) return new Response("forbidden", { status: 403 });

  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  await redis.set(`oauth:${state}`, verifier, { ex: 600 });

  const auth = new URL("https://www.canva.com/api/oauth/authorize");
  auth.search = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "s256",
    scope: SCOPES,
    response_type: "code",
    client_id: process.env.CANVA_CLIENT_ID!,
    state,
    redirect_uri: `${process.env.BASE_URL}/api/canva-callback`,
  }).toString();
  return Response.redirect(auth.toString(), 302);
}
