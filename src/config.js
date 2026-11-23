// Configuración local (se guarda en data/config.json, nunca sale de tu PC)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const STREAMS_DIR = path.join(DATA_DIR, "streams");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

fs.mkdirSync(STREAMS_DIR, { recursive: true });

export const PORT = Number(process.env.PORT || 3939);

const DEFAULTS = {
  aiProvider: "auto",             // auto | claude | ollama | none
  ollamaModel: "qwen3:8b",
  ollamaUrl: "http://127.0.0.1:11434",
  anthropicApiKey: "",            // vacío = usa ANTHROPIC_API_KEY del sistema / `ant auth login`
  claudeModel: "claude-opus-5-5",
  claudeEffort: "high",
  twitchClientId: "",
  twitchClientSecret: "",
  channel: "",                    // canal por defecto (si no conectás la cuenta)
  outputDir: path.join(os.homedir(), "Downloads", "ClipsTwitch"),
  whisperModel: "Xenova/whisper-small",
  language: "spanish",
  chatDelaySec: 6,                // el chat reacciona unos segundos después del momento
  minClipSec: 15,
  maxClipSec: 59,
  defaultLayout: "blur",          // blur | crop | facecam
  facecam: { x: 0.0, y: 0.0, w: 0.28, h: 0.30 }, // rectángulo de la cámara (fracciones de la imagen)
  subtitleStyle: "amarillo",
};

let cache = null;

export function getConfig() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  cache = { ...DEFAULTS, ...saved, facecam: { ...DEFAULTS.facecam, ...(saved.facecam || {}) } };
  return cache;
}

export function saveConfig(patch) {
  const cur = getConfig();
  cache = { ...cur, ...patch, facecam: { ...cur.facecam, ...(patch.facecam || {}) } };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

/** Versión segura para mandar al navegador (sin secretos completos). */
export function publicConfig() {
  const c = getConfig();
  const mask = (s) => (s ? s.slice(0, 4) + "…" + s.slice(-3) : "");
  return {
    ...c,
    anthropicApiKey: mask(c.anthropicApiKey),
    twitchClientSecret: mask(c.twitchClientSecret),
    hasAnthropicKey: Boolean(c.anthropicApiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    hasTwitchApp: Boolean(c.twitchClientId && c.twitchClientSecret),
    redirectUri: `http://localhost:${PORT}/auth/twitch/callback`,
  };
}

export function streamDir(vodId) {
  const d = path.join(STREAMS_DIR, String(vodId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
