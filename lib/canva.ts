import { redis } from "./store";

const BASE = "https://api.canva.com/rest/v1";
export const SCOPES =
  "asset:read asset:write design:meta:read design:content:read design:content:write folder:read folder:write";

interface Tokens {
  access: string;
  refresh: string;
  exp: number; // epoch ms
}

export class CanvaAuthError extends Error {}

const basicAuth = () =>
  "Basic " + Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString("base64");

export async function scambiaToken(params: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j = await r.json();
  if (!r.ok) throw new CanvaAuthError(`Token Canva: ${JSON.stringify(j)}`);
  const t = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + j.expires_in * 1000 };
  await redis.set("canva:tokens", t);
  return t;
}

// Il refresh token Canva è monouso: un lock evita che due richieste parallele lo brucino entrambe
async function accessToken(): Promise<string> {
  for (let tentativo = 0; tentativo < 10; tentativo++) {
    const t = await redis.get<Tokens>("canva:tokens");
    if (!t) throw new CanvaAuthError("Nessun token Canva salvato: serve il login");
    if (t.exp - 60_000 > Date.now()) return t.access;

    const lock = await redis.set("canva:lock", "1", { nx: true, ex: 20 });
    if (lock) {
      try {
        return (await scambiaToken({ grant_type: "refresh_token", refresh_token: t.refresh })).access;
      } finally {
        await redis.del("canva:lock");
      }
    }
    await new Promise((r) => setTimeout(r, 1000)); // un altro processo sta rinnovando
  }
  throw new Error("Timeout rinnovo token Canva");
}

export async function canva<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(init.headers || {}) },
  });
  const testo = await r.text();
  if (r.status === 401) throw new CanvaAuthError(`Canva 401 ${path}: ${testo}`);
  if (!r.ok) throw new Error(`Canva ${r.status} ${init.method || "GET"} ${path}: ${testo}`);
  return (testo ? JSON.parse(testo) : {}) as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// I job Canva sono asincroni: si crea e poi si interroga finché non è success/failed
async function attendiJob<T>(path: string, estrai: (j: any) => { job: any }): Promise<T> {
  for (let i = 0; i < 120; i++) {
    const { job } = estrai(await canva(path));
    if (job.status === "success") return job as T;
    if (job.status === "failed") throw new Error(`Job Canva fallito ${path}: ${JSON.stringify(job.error)}`);
    await new Promise((r) => setTimeout(r, 500)); // i job Canva finiscono in pochi secondi: poll stretto
  }
  throw new Error(`Job Canva troppo lento: ${path}`);
}

export async function caricaFoto(img: Buffer, nome: string): Promise<string> {
  const { job } = await canva<{ job: any }>("/asset-uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Asset-Upload-Metadata": JSON.stringify({ name_base64: Buffer.from(nome.slice(0, 50)).toString("base64") }),
    },
    body: new Uint8Array(img),
  });
  const fatto: any = job.status === "success" ? job : await attendiJob(`/asset-uploads/${job.id}`, (j) => j);
  return fatto.asset.id;
}

export async function autofill(
  templateId: string,
  titolo: string,
  dati: { fotoAssetId: string; risultato: string; categoria: string; squadraA: string; squadraB: string },
): Promise<string> {
  const { job } = await canva<{ job: any }>(
    "/autofills",
    json({
      type: "create_from_design",
      design_id: templateId,
      title: titolo,
      data: {
        FOTO: { type: "image", asset_id: dati.fotoAssetId },
        RISULTATO: { type: "text", text: dati.risultato },
        CATEGORIA: { type: "text", text: dati.categoria },
        SQUADRA_A: { type: "text", text: dati.squadraA },
        SQUADRA_B: { type: "text", text: dati.squadraB },
      },
    }),
  );
  const fatto: any = job.status === "success" ? job : await attendiJob(`/autofills/${job.id}`, (j) => j);
  return fatto.result.design.id;
}

// Autofill di soli campi testo (carosello): campi = { DATA: "...", R1_CASA: "...", ... }
export const autofillTesti = (templateId: string, titolo: string, campi: Record<string, string>) =>
  autofillCampi(templateId, titolo, campi, {});

// Testi + immagini (asset id Canva). I campi non passati restano come nel template
export async function autofillCampi(
  templateId: string,
  titolo: string,
  testi: Record<string, string>,
  immagini: Record<string, string>,
): Promise<string> {
  const data = {
    ...Object.fromEntries(Object.entries(testi).map(([k, text]) => [k, { type: "text", text }])),
    ...Object.fromEntries(Object.entries(immagini).map(([k, asset_id]) => [k, { type: "image", asset_id }])),
  };
  const { job } = await canva<{ job: any }>("/autofills", json({ type: "create_from_design", design_id: templateId, title: titolo, data }));
  const fatto: any = job.status === "success" ? job : await attendiJob(`/autofills/${job.id}`, (j) => j);
  const id: string = fatto.result.design.id;
  // Le prove degli script ("PROVA …") non restano in root: vanno in Bot · Prove, svuotata a ogni cambio mese
  if (/^prova\b/i.test(titolo)) await canva("/folders/move", json({ to_folder_id: await cartellaProve(), item_id: id })).catch(() => {});
  return id;
}

export async function esportaImmagine(designId: string): Promise<Buffer> {
  const { job } = await canva<{ job: any }>("/exports", json({ design_id: designId, format: { type: "jpg", quality: 92 } }));
  const fatto: any = job.status === "success" ? job : await attendiJob(`/exports/${job.id}`, (j) => j);
  const r = await fetch(fatto.urls[0]);
  if (!r.ok) throw new Error(`Download export Canva: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---- Archivio su Canva (riordino 2026-10-20) ----
// Bot · Grafiche / AAAA-MM: una sottocartella per mese con quello che il bot genera.
// Si tengono 2 mesi oltre al corrente: all'apertura di un mese nuovo le cartelle più vecchie si cancellano.
// L'API Canva non cancella i design, ma cancellare una cartella manda il contenuto nel Cestino (recuperabile 30 giorni).
// Le grafiche restano comunque su Telegram e Instagram.
const MESI_TENUTI = 2;

async function cartellaRedis(chiave: string, nome: string, padre: string): Promise<string> {
  const salvata = await redis.get<string>(chiave);
  if (salvata) return salvata;
  const { folder } = await canva<{ folder: { id: string } }>("/folders", json({ name: nome, parent_folder_id: padre }));
  await redis.set(chiave, folder.id);
  return folder.id;
}

// La cartella madre è la vecchia "Bot Risultati", rinominata "Bot · Grafiche" (stesso ID)
const cartellaGrafiche = () => cartellaRedis("canva:folder", "Bot · Grafiche", "root");
const cartellaProve = () => cartellaRedis("canva:folder:prove", "Bot · Prove", "root");

const meseDi = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }).slice(0, 7); // "2026-10"

async function cartellaMese(): Promise<string> {
  const mese = meseDi(new Date());
  const salvata = await redis.get<string>(`canva:folder:${mese}`);
  if (salvata) return salvata;
  const madre = await cartellaGrafiche();
  // Il mese potrebbe esistere già (creato a mano o dal riordino): si cerca prima di crearlo
  const j: any = await canva(`/folders/${madre}/items?item_types=folder&limit=100`);
  const cartelle: { id: string; name: string }[] = j.items.map((x: any) => x.folder);
  const id = cartelle.find((c) => c.name === mese)?.id ?? (await canva<any>("/folders", json({ name: mese, parent_folder_id: madre }))).folder.id;
  await redis.set(`canva:folder:${mese}`, id);
  // Cambio mese: pulizia una volta sola, qui
  await pulisciArchivio(cartelle, mese).catch((e) => console.error("pulizia archivio Canva:", e));
  return id;
}

async function pulisciArchivio(cartelle: { id: string; name: string }[], mese: string) {
  const [a, m] = mese.split("-").map(Number);
  const limite = meseDi(new Date(Date.UTC(a, m - 1 - MESI_TENUTI, 15))); // cartelle prima di questo mese vanno via
  for (const c of cartelle) {
    if (/^\d{4}-\d{2}$/.test(c.name) && c.name < limite) {
      await canva(`/folders/${c.id}`, { method: "DELETE" });
      await redis.del(`canva:folder:${c.name}`);
    }
  }
  // Le prove degli script non servono oltre il mese
  const prove = await redis.get<string>("canva:folder:prove");
  if (prove) {
    await canva(`/folders/${prove}`, { method: "DELETE" }).catch(() => {});
    await redis.del("canva:folder:prove");
  }
}

export async function spostaInCartella(designId: string) {
  await canva("/folders/move", json({ to_folder_id: await cartellaMese(), item_id: designId }));
}

export async function archivia(designId: string, assetId: string) {
  await spostaInCartella(designId);
  // La foto resta dentro il design anche dopo aver cancellato l'upload
  await canva(`/assets/${assetId}`, { method: "DELETE" });
}
