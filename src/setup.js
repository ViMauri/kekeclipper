// Verificación de complementos al iniciar (ffmpeg, Ollama + modelo, voz, Twitch) e instalación desde la app.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { getConfig } from "./config.js";
import { ffmpegAvailable, refreshFfmpeg } from "./media.js";
import { checkOllama, ollamaInfo, hasClaudeKey } from "./ai.js";
import { whisperCached, getAsr } from "./transcribe.js";
import { clientId } from "./twitch.js";

const win = process.platform === "win32";

/** Busca ollama.exe aunque el PATH de esta sesión no lo tenga. */
export function findOllama() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const cands = [path.join(local, "Programs", "Ollama", "ollama.exe"), "C:\\Program Files\\Ollama\\ollama.exe"];
  for (const c of cands) if (fs.existsSync(c)) return c;
  try {
    const r = spawnSync(win ? "where" : "which", ["ollama"], { encoding: "utf8" });
    const line = (r.stdout || "").split(/\r?\n/).find(Boolean);
    if (r.status === 0 && line) return line.trim();
  } catch {}
  return null;
}

let starting = null;
/** Arranca Ollama en segundo plano si está instalado y apagado. */
export async function startOllama() {
  if ((await checkOllama()).up) return true;
  const exe = findOllama();
  if (!exe) return false;
  if (!starting) {
    starting = (async () => {
      spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 750));
        if ((await checkOllama()).up) return true;
      }
      return false;
    })().finally(() => setTimeout(() => (starting = null), 1000));
  }
  return starting;
}

function modelPulled() {
  const want = getConfig().ollamaModel;
  return ollamaInfo().models.some((m) => m === want || m === `${want}:latest`);
}

/** Estado de cada complemento. required=true bloquea el uso de la app. */
export async function runChecks({ autoStart = true } = {}) {
  const cfg = getConfig();
  const ff = await ffmpegAvailable();
  const ollamaExe = findOllama();
  let ol = await checkOllama();
  if (!ol.up && ollamaExe && autoStart) { await startOllama(); ol = ollamaInfo(); }
  const usingClaude = cfg.aiProvider === "claude" || (cfg.aiProvider === "auto" && hasClaudeKey());
  const aiOff = cfg.aiProvider === "none";
  const needOllama = !usingClaude && !aiOff;
  const items = [
    { id: "node", name: "Node.js", ok: true, detail: process.version, required: true },
    { id: "ffmpeg", name: "FFmpeg (cortar y armar los videos)", ok: ff, required: true, detail: ff ? "Instalado" : "Falta", action: ff ? null : "install-ffmpeg" },
    { id: "ollama", name: "Ollama (IA local gratis)", ok: !!ollamaExe || !needOllama, required: needOllama,
      detail: ollamaExe ? "Instalado" : needOllama ? "Falta" : "No hace falta (usás Claude)", action: !ollamaExe && needOllama ? "install-ollama" : null },
    { id: "ollama-run", name: "Ollama encendido", ok: ol.up || !needOllama, required: needOllama,
      detail: ol.up ? "Funcionando" : needOllama ? "Apagado" : "—", action: !ol.up && ollamaExe && needOllama ? "start-ollama" : null },
    { id: "model", name: `Modelo de humor (${cfg.ollamaModel})`, ok: (ol.up && modelPulled()) || !needOllama, required: needOllama,
      detail: !needOllama ? "—" : !ol.up ? "Esperando a Ollama" : modelPulled() ? "Descargado" : `Falta descargar (${cfg.ollamaModel.includes("8b") ? "~5 GB" : "varios GB"})`, action: needOllama && ol.up && !modelPulled() ? "pull-model" : null },
    { id: "whisper", name: "Modelo de voz (transcribe lo que decís)", ok: whisperCached(), required: false,
      detail: whisperCached() ? "Descargado" : "Se baja solo la primera vez (~250 MB)", action: whisperCached() ? null : "download-whisper" },
    { id: "twitch", name: "Conexión con Twitch", ok: !!clientId(), required: true,
      detail: clientId() ? "Lista" : "Falta el ID público de la app" },
  ];
  if (usingClaude) items.splice(2, 0, { id: "claude", name: "Claude (IA en la nube)", ok: true, required: false, detail: "API key cargada" });
  return { items, ready: items.every((i) => i.ok || !i.required), wingetAvailable: hasWinget() };
}

function hasWinget() {
  if (!win) return false;
  try { return spawnSync("winget", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0; } catch { return false; }
}

function winget(id, ctx) {
  return new Promise((resolve, reject) => {
    ctx.progress(0.05, `Instalando ${id} con winget… (puede pedir permiso de Windows)`);
    const p = spawn("winget", ["install", "--id", id, "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"], { windowsHide: true });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out = (out + s).slice(-3000);
      const m = /(\d{1,3})\s*%/.exec(s);
      if (m) ctx.progress(0.05 + 0.9 * Math.min(1, +m[1] / 100), `Instalando ${id}… ${m[1]}%`);
    };
    p.stdout.on("data", onData); p.stderr.on("data", onData);
    p.on("error", (e) => reject(new Error("No pude ejecutar winget: " + e.message)));
    p.on("close", (code) => {
      // 0 = ok; -1978335189 (0x8A15002B) = ya estaba instalado / sin actualización
      if (code === 0 || /already installed|ya está instalado|No available upgrade|No se encontró ninguna actualización/i.test(out)) resolve();
      else reject(new Error(`winget terminó con código ${code}. ${out.split(/\r?\n/).filter((l) => l.trim() && !/[█▒]/.test(l)).slice(-3).join(" ")}`));
    });
  });
}

async function pullModel(ctx) {
  const cfg = getConfig();
  const r = await fetch(`${cfg.ollamaUrl}/api/pull`, { method: "POST", body: JSON.stringify({ model: cfg.ollamaModel, stream: true }) });
  if (!r.ok || !r.body) throw new Error("Ollama no respondió a la descarga");
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    if (ctx.cancelled) throw new Error("Cancelado");
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.total && j.completed) ctx.progress(j.completed / j.total, `Descargando ${cfg.ollamaModel}: ${(j.completed / 1e9).toFixed(2)} / ${(j.total / 1e9).toFixed(2)} GB`);
      else if (j.status) ctx.progress(null, j.status);
    }
  }
  await checkOllama();
}

/** Ejecuta una acción de instalación (la pide el usuario con un botón). */
export async function runSetupAction(action, ctx) {
  switch (action) {
    case "install-ffmpeg":
      await winget("Gyan.FFmpeg", ctx);
      refreshFfmpeg();
      if (!(await ffmpegAvailable())) throw new Error("Se instaló pero no lo encuentro todavía. Cerrá y abrí la app.");
      return { ok: true };
    case "install-ollama":
      await winget("Ollama.Ollama", ctx);
      ctx.progress(0.97, "Encendiendo Ollama…");
      await startOllama();
      return { ok: true };
    case "start-ollama":
      ctx.progress(0.3, "Encendiendo Ollama…");
      if (!(await startOllama())) throw new Error("Ollama no arrancó. Abrilo desde el menú Inicio.");
      return { ok: true };
    case "pull-model":
      if (!(await startOllama())) throw new Error("Ollama no está encendido.");
      await pullModel(ctx);
      return { ok: true };
    case "download-whisper": {
      const files = new Map();
      await getAsr((m) => ctx.progress(null, m), (p) => {
        if (p.status === "progress" && p.total) {
          files.set(p.file, [p.loaded, p.total]);
          const [l, t] = [...files.values()].reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
          ctx.progress(l / t, `Bajando modelo de voz: ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`);
        }
      });
      return { ok: true };
    }
    default:
      throw new Error("Acción desconocida");
  }
}
