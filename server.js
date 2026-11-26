// Servidor local: http://localhost:3939  (solo escucha en tu PC)
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ROOT, PORT, getConfig, saveConfig, publicConfig, streamDir } from "./src/config.js";
import * as twitch from "./src/twitch.js";
import { startJob, getJob, listJobs, cancelJob, runningJobFor } from "./src/jobs.js";
import { analyzeVod, loadAnalysis, saveMoments, hasAnalysis } from "./src/analyzer.js";
import { renderClip, buildSummary, ensureSubs } from "./src/produce.js";
import { getHashtags, refreshHashtags, pickHashtags } from "./src/hashtags.js";
import { ffmpegAvailable, grabFrame } from "./src/media.js";
import { normalizeFrame } from "./src/framing.js";
import { runChecks, runSetupAction, startOllama } from "./src/setup.js";
import { aiAvailable, aiProvider, webSearchAvailable, checkOllama, ollamaInfo } from "./src/ai.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
let lastSeen = Date.now();
app.use("/api", (req, res, next) => { lastSeen = Date.now(); next(); });
app.use(express.static(path.join(ROOT, "public")));
// La interfaz usa el mismo cálculo de encuadre que el render
app.get("/framing.js", (req, res) => res.type("text/javascript").sendFile(path.join(ROOT, "src", "framing.js")));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ---------- Estado / config ----------
app.get("/api/status", wrap(async (req, res) => {
  await checkOllama();
  res.json({ ffmpeg: await ffmpegAvailable(), ai: aiAvailable(), aiProvider: aiProvider(), webSearch: webSearchAvailable(), ollama: ollamaInfo(), twitchLogin: !twitch.clientId() ? null : getConfig().twitchClientSecret && getConfig().twitchClientId ? "oauth" : "device", user: twitch.getSession()?.user || null, config: publicConfig() });
}));
app.post("/api/config", wrap(async (req, res) => {
  const allowed = ["aiProvider", "ollamaModel", "ollamaUrl", "anthropicApiKey", "claudeModel", "claudeEffort", "twitchClientId", "twitchClientSecret", "channel", "outputDir", "whisperModel", "chatDelaySec", "minClipSec", "maxClipSec", "defaultLayout", "facecam", "subtitleStyle"];
  const patch = {};
  for (const k of allowed) if (k in req.body) {
    const v = req.body[k];
    if ((k === "anthropicApiKey" || k === "twitchClientSecret") && typeof v === "string" && v.includes("…")) continue; // valor enmascarado, no cambiar
    patch[k] = ["chatDelaySec", "minClipSec", "maxClipSec"].includes(k) ? Number(v) : v;
  }
  saveConfig(patch);
  res.json(publicConfig());
}));

// ---------- Verificación de complementos ----------
app.get("/api/ping", (req, res) => res.json({ ok: true, app: "kekeclipper" }));
app.get("/api/setup", wrap(async (req, res) => res.json(await runChecks())));
const SETUP_ACTIONS = ["install-ffmpeg", "install-ollama", "start-ollama", "pull-model", "download-whisper"];
app.post("/api/setup/:action", wrap(async (req, res) => {
  const { action } = req.params;
  if (!SETUP_ACTIONS.includes(action)) return res.status(400).json({ error: "Acción inválida" });
  const job = runningJobFor("setup", action) || startJob("setup", { key: action, action }, (ctx) => runSetupAction(action, ctx));
  res.json(job);
}));

// ---------- Twitch ----------
const oauthStates = new Set();
app.get("/auth/twitch/login", (req, res) => {
  if (!getConfig().twitchClientId || !getConfig().twitchClientSecret) return res.redirect("/#/config");
  const st = crypto.randomUUID();
  oauthStates.add(st);
  res.redirect(twitch.authUrl(st));
});
app.get("/auth/twitch/callback", wrap(async (req, res) => {
  if (!oauthStates.has(req.query.state)) return res.status(400).send("Estado OAuth inválido, probá de nuevo.");
  oauthStates.delete(req.query.state);
  if (req.query.error) return res.redirect("/?twitch_error=" + encodeURIComponent(req.query.error_description || req.query.error));
  await twitch.exchangeCode(req.query.code);
  res.redirect("/");
}));
// Login por código (ID público, sin secreto): la UI muestra el código y hace polling
app.post("/api/twitch/device/start", wrap(async (req, res) => res.json(await twitch.startDeviceLogin())));
app.post("/api/twitch/device/poll", wrap(async (req, res) => res.json(await twitch.pollDeviceLogin())));
app.post("/api/logout", (req, res) => { twitch.logout(); res.json({ ok: true }); });

app.get("/api/vods", wrap(async (req, res) => {
  const vods = await twitch.listVods(req.query.channel);
  res.json(vods.map((v) => ({ ...v, analyzed: hasAnalysis(v.id) })));
}));

// ---------- Análisis ----------
app.post("/api/analyze", wrap(async (req, res) => {
  const { vodId, maxClips = "auto", deep = false, reuse = true } = req.body;
  if (!/^\d+$/.test(String(vodId))) return res.status(400).json({ error: "VOD inválida" });
  const existing = runningJobFor("analyze", vodId);
  if (existing) return res.json(existing);
  const job = startJob("analyze", { key: vodId, vodId }, (ctx) => analyzeVod(vodId, { maxClips, deep, reuse }, ctx));
  res.json(job);
}));

app.get("/api/jobs", (req, res) => res.json(listJobs()));
app.get("/api/jobs/:id", (req, res) => { const j = getJob(req.params.id); j ? res.json(j) : res.status(404).json({ error: "no existe" }); });
app.post("/api/jobs/:id/cancel", (req, res) => res.json(cancelJob(req.params.id)));

app.get("/api/streams/:vodId", wrap(async (req, res) => {
  const a = loadAnalysis(req.params.vodId);
  a.moments = a.moments.map((m) => ({ ...m, hashtagsFinal: pickHashtags(m.hashtags, "shorts", 12), renderedUrl: m.rendered && fs.existsSync(m.rendered) ? "/media?p=" + encodeURIComponent(m.rendered) : null }));
  if (a.summary?.file) a.summary.url = "/media?p=" + encodeURIComponent(a.summary.file);
  res.json(a);
}));

app.patch("/api/streams/:vodId/moments/:id", wrap(async (req, res) => {
  const { moments } = loadAnalysis(req.params.vodId);
  const m = moments.find((x) => x.id === Number(req.params.id));
  if (!m) return res.status(404).json({ error: "no existe" });
  for (const k of ["start", "end", "titulo", "gancho", "descripcion", "layout", "cropX", "selected", "hashtags", "subsOn", "subsEdited", "subY", "subScale", "subStyle", "hookOn", "hookDur", "hookY"]) if (k in req.body) m[k] = req.body[k];
  if (req.body.frame === null) delete m.frame; // vuelve al encuadre por defecto
  else if (req.body.frame && typeof req.body.frame === "object") m.frame = normalizeFrame(req.body.frame, { facecam: getConfig().facecam, cropX: m.cropX ?? 0.5 });
  if (Array.isArray(req.body.subs)) {
    m.subs = req.body.subs
      .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || "").slice(0, 200) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text.trim())
      .sort((a, b) => a.start - b.start);
    m.subsEdited = true;
  }
  m.start = Number(m.start); m.end = Number(m.end); m.cropX = Number(m.cropX ?? 0.5);
  for (const k of ["subY", "subScale", "hookY", "hookDur"]) if (m[k] != null) m[k] = Number(m[k]);
  saveMoments(req.params.vodId, moments);
  res.json(m);
}));

// Subtítulos del clip para editarlos (los transcribe si todavía no existen)
app.post("/api/streams/:vodId/moments/:id/subs", wrap(async (req, res) => {
  const { vodId, id } = req.params;
  const key = `${vodId}:${id}`;
  const job = runningJobFor("subs", key) || startJob("subs", { key, vodId, momentId: Number(id) }, async (ctx) => ({ subs: await ensureSubs(vodId, id, ctx, { force: !!req.body?.force }) }));
  res.json(job);
}));

app.post("/api/streams/:vodId/moments/:id/render", wrap(async (req, res) => {
  const { vodId, id } = req.params;
  const key = `${vodId}:${id}`;
  const job = runningJobFor("render", key) || startJob("render", { key, vodId, momentId: Number(id) }, (ctx) => renderClip(vodId, id, ctx));
  res.json(job);
}));

app.post("/api/streams/:vodId/render-selected", wrap(async (req, res) => {
  const { vodId } = req.params;
  const sel = loadAnalysis(vodId).moments.filter((m) => m.selected);
  const job = startJob("render-batch", { key: vodId, vodId }, async (ctx) => {
    const files = [];
    for (let i = 0; i < sel.length; i++) {
      if (ctx.cancelled) break;
      const sub = { progress: (p, msg) => ctx.progress(p == null ? null : (i + p) / sel.length, msg ? `Clip ${i + 1}/${sel.length}: ${msg}` : null), log: ctx.log, get cancelled() { return ctx.cancelled; } };
      try { files.push((await renderClip(vodId, sel[i].id, sub)).file); } catch (e) { ctx.log(`Clip ${sel[i].id} falló: ${e.message}`); }
    }
    return { files };
  });
  res.json(job);
}));

app.post("/api/streams/:vodId/summary", wrap(async (req, res) => {
  const { vodId } = req.params;
  const job = runningJobFor("summary", vodId) || startJob("summary", { key: vodId, vodId }, (ctx) => buildSummary(vodId, { render: req.body.render !== false, ids: req.body.ids }, ctx));
  res.json(job);
}));

app.get("/api/streams/:vodId/frame", wrap(async (req, res) => {
  const { vodId } = req.params;
  const t = Number(req.query.t || 600);
  const f = path.join(streamDir(vodId), `frame_${Math.floor(t)}.jpg`);
  if (!fs.existsSync(f)) await grabFrame((await twitch.getPlaylists(vodId)).source, t, f);
  res.sendFile(f);
}));

// ---------- Hashtags ----------
app.get("/api/hashtags", (req, res) => res.json(getHashtags()));
app.post("/api/hashtags/refresh", wrap(async (req, res) => {
  const job = runningJobFor("hashtags", "x") || startJob("hashtags", { key: "x" }, async (ctx) => { ctx.progress(0.1, "Claude investigando tendencias de hoy en la web…"); return refreshHashtags({ force: true }); });
  res.json(job);
}));

// ---------- Archivos locales ----------
function insideOutput(p) {
  const out = path.resolve(getConfig().outputDir);
  const abs = path.resolve(String(p || ""));
  return abs.toLowerCase().startsWith(out.toLowerCase() + path.sep) ? abs : null;
}
app.get("/media", (req, res) => {
  const f = insideOutput(req.query.p);
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});
app.post("/api/reveal", (req, res) => {
  const f = req.body.path ? insideOutput(req.body.path) : null;
  const target = f || path.resolve(getConfig().outputDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === "win32") spawn("explorer.exe", f ? [`/select,${f}`] : [target], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [f ? path.dirname(f) : target], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  🎬 KekeClipper corriendo en ${url}\n`);
  if (!(await ffmpegAvailable())) console.warn("  ⚠️  No encontré ffmpeg en el PATH. Instalalo (winget install Gyan.FFmpeg).");
  if (!process.env.NO_OPEN) {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
  startOllama().catch(() => {});
  if (process.env.APP_MODE) {
    setInterval(() => {
      const busy = listJobs().some((j) => j.status === "running");
      if (!busy && Date.now() - lastSeen > 5 * 60 * 1000) { console.log("Sin ventana abierta: cierro."); process.exit(0); }
    }, 30000).unref();
  }
  refreshHashtags().catch((e) => console.warn("  Hashtags: " + e.message));
});
