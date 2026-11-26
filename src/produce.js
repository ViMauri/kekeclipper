// Producción: Shorts verticales con subtítulos y resumen horizontal para YouTube. Se guardan en tu PC.
import fs from "node:fs";
import path from "node:path";
import { getConfig, streamDir, readJson, writeJson } from "./config.js";
import { getPlaylists } from "./twitch.js";
import { readAudio, renderShort } from "./media.js";
import { transcribe } from "./transcribe.js";
import { buildAss } from "./subtitles.js";
import { normalizeFrame } from "./framing.js";
import { pickHashtags } from "./hashtags.js";
import { loadAnalysis, saveMoments } from "./analyzer.js";

export const slug = (s) => (s || "clip").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 50) || "clip";

export function outFolder(meta) {
  const d = path.join(getConfig().outputDir, `${meta.channel || "twitch"}_${(meta.createdAt || "").slice(0, 10)}_${meta.id}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Subtítulos del clip (tiempos ABSOLUTOS del VOD, así sobreviven si movés el inicio/fin).
 * Si no hay, o el clip se estiró fuera de lo transcripto y el usuario no los tocó, se transcribe de nuevo.
 */
export async function ensureSubs(vodId, momentId, ctx, { force = false } = {}) {
  const file = path.join(streamDir(vodId), "moments.json");
  const all = readJson(file, []);
  const m = all.find((x) => x.id === Number(momentId));
  if (!m) throw new Error("Momento no encontrado");
  const covered = m.subsRange && m.subsRange[0] <= m.start + 0.5 && m.subsRange[1] >= m.end - 0.5;
  if (!force && m.subs && (covered || m.subsEdited)) return m.subs;
  ctx.progress(null, "Transcribiendo para subtítulos…");
  const pl = await getPlaylists(vodId);
  const samples = await readAudio(pl.audio, m.start, m.end - m.start, 16000);
  const segs = (await transcribe(samples, m.start, (msg) => ctx.progress(null, msg)))
    .filter((s) => !/^[\s.…¡!¿?-]*$/.test(s.text))
    .map((s) => ({ start: +s.start.toFixed(2), end: +Math.min(s.end, m.end).toFixed(2), text: s.text }));
  const fresh = readJson(file, []);
  const mm = fresh.find((x) => x.id === m.id);
  Object.assign(mm, { subs: segs, subsRange: [m.start, m.end], subsEdited: false });
  saveMoments(vodId, fresh);
  return segs;
}

export async function renderClip(vodId, momentId, ctx) {
  const { meta, moments } = loadAnalysis(vodId);
  const m = moments.find((x) => x.id === Number(momentId));
  if (!m) throw new Error("Momento no encontrado");
  const cfg = getConfig();
  const folder = outFolder(meta);
  const base = `${String(m.id).padStart(2, "0")}_${slug(m.titulo)}`;
  const work = path.join(streamDir(vodId), "work");
  fs.mkdirSync(work, { recursive: true });

  ctx.progress(0.05, "Obteniendo el tramo desde Twitch…");
  const pl = await getPlaylists(vodId);
  const dur = m.end - m.start;

  let segs = [];
  if (m.subsOn !== false) {
    try {
      const subs = await ensureSubs(vodId, m.id, ctx);
      segs = subs.filter((s) => s.end > m.start && s.start < m.end).map((s) => ({ ...s, start: s.start - m.start, end: Math.min(s.end, m.end) - m.start }));
    } catch (e) { ctx.log("Sin subtítulos: " + e.message); }
  }
  const layout = m.layout || cfg.defaultLayout;
  const frame = normalizeFrame(m.frame, { facecam: cfg.facecam, cropX: m.cropX ?? 0.5 });
  const assFile = path.join(work, `${base}.ass`);
  const hook = m.hookOn !== false && m.gancho ? m.gancho : null;
  fs.writeFileSync(assFile, buildAss({
    segs, hook, hookDur: m.hookDur ?? 4, duration: dur, style: m.subStyle || cfg.subtitleStyle, layout,
    subY: m.subY ?? (layout === "facecam" ? frame.camH + 460 : undefined), hookY: m.hookY ?? 250, subScale: m.subScale ?? 100, mode: m.subsEdited ? "line" : "auto",
  }), "utf8");

  ctx.progress(0.3, "Renderizando Short 9:16…");
  const outFile = path.join(folder, `${base}.mp4`);
  await renderShort({ url: pl.source, start: m.start, end: m.end, layout, frame, assFile, outFile, onProgress: (p) => ctx.progress(0.3 + 0.68 * p) });

  const tags = pickHashtags(m.hashtags, "shorts", 12);
  const caption = `${m.titulo}\n\n${m.descripcion || ""}\n\n${tags.join(" ")}`;
  fs.writeFileSync(path.join(folder, `${base}.txt`), `TÍTULO:\n${m.titulo}\n\nDESCRIPCIÓN (YouTube Shorts):\n${caption}\n\nINSTAGRAM:\n${m.titulo}\n${m.descripcion || ""}\n\n${pickHashtags(m.hashtags, "instagram", 15).join(" ")}\n\nTIKTOK:\n${m.titulo} ${pickHashtags(m.hashtags, "tiktok", 8).join(" ")}\n\nOriginal: https://www.twitch.tv/videos/${vodId}?t=${Math.floor(m.start / 3600)}h${Math.floor(m.start / 60) % 60}m${Math.floor(m.start % 60)}s\n`, "utf8");

  const all = readJson(path.join(streamDir(vodId), "moments.json"), []);
  const mm = all.find((x) => x.id === m.id);
  mm.rendered = outFile; mm.caption = caption;
  saveMoments(vodId, all);
  return { file: outFile, caption };
}

// El resumen para YouTube vive en summary.js
export { buildSummary } from "./summary.js";
