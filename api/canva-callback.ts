import { redis } from "../lib/store";
import { scambiaToken } from "../lib/canva";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const verifier = await redis.getdel<string>(`oauth:${state}`);
  if (!code || !verifier) return new Response("Login scaduto o non valido, riapri il link di login.", { status: 400 });

  await scambiaToken({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: `${process.env.BASE_URL}/api/canva-callback`,
  });
  return new Response("✅ Canva collegato. Puoi chiudere questa pagina.", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
