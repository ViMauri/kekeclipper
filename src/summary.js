// Resumen del directo para YouTube: máx ~10 min, en orden cronológico (se entiende la historia),
// cortes en pausas del habla (no a mitad de frase) y transiciones cortas que no frenan el ritmo.
import fs from "node:fs";
import path from "node:path";
import { streamDir, readJson, writeJson } from "./config.js";
import { getPlaylists } from "./twitch.js";
import { readAudio, renderHorizontal, joinWithCrossfade, probeDuration } from "./media.js";
import { pickHashtags } from "./hashtags.js";
import { loadAnalysis, chatTimeline, fmt } from "./analyzer.js";
import { aiAvailable, summarizeStream, checkOllama } from "./ai.js";
import { slug, outFolder } from "./produce.js";

export const MAX_SUMMARY_SEC = 600; // 10 minutos
const XF = 0.3; // transición entre momentos (s)
const MERGE_GAP = 12; // si dos momentos están a menos de esto, se unen en un solo tramo

/** Todo lo transcripto de este VOD (ventanas del análisis, transcripción completa y subtítulos de clips). */
function allSegments(vodId, moments) {
  const dir = streamDir(vodId);
  const segs = [];
  for (const arr of Object.values(readJson(path.join(dir, "windows.json"), {}))) segs.push(...(arr || []));
  segs.push(...(readJson(path.join(dir, "transcript.json"), []) || []));
  for (const m of moments) if (m.subs && !m.subsEdited) segs.push(...m.subs);
  return segs.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start);
}

/** Si el corte cae a mitad de una frase, lo corre al borde de esa frase (máx `limit` s). */
function snapToSpeech(t, segs, dir, limit = 6) {
  const inside = segs.filter((s) => s.start < t && s.end > t);
  if (!inside.length) return t;
  if (dir < 0) { const a = Math.min(...inside.map((s) => s.start)); return t - a <= limit ? a : t; }
  const b = Math.max(...inside.map((s) => s.end)); return b - t <= limit ? b : t;
}

/** Busca el instante más silencioso cerca de t (para que el corte caiga en una pausa). */
async function quietestNear(audioUrl, t, before, after) {
  const from = Math.max(0, t - before), dur = before + after;
  try {
    const sr = 16000, x = await readAudio(audioUrl, from, dur, sr);
    const win = Math.round(sr * 0.05);
    let best = t, bestE = Infinity;
    for (let i = 0; i + win <= x.length; i += win / 2) {
      let e = 0; for (let k = i; k < i + win; k++) e += x[k] * x[k];
      const at = from + (i + win / 2) / sr;
      const score = Math.sqrt(e / win) * (1 + Math.abs(at - t) * 0.15); // preferí cerca del corte original
      if (score < bestE) { bestE = score; best = at; }
    }
    return best;
  } catch { return t; }
}

/** Elige los momentos y arma los tramos (unidos, ajustados a pausas y dentro de 10 min). */
export function planSegments(moments, order, segs, maxSec = MAX_SUMMARY_SEC) {
  const byId = new Map(moments.map((m) => [m.id, m]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  // prioridad: lo que eligió la IA primero, y dentro de eso, el puntaje
  const prio = [...ordered].sort((a, b) => b.score - a.score);
  for (const m of [...moments].sort((a, b) => b.score - a.score)) if (!prio.includes(m) && m.keep !== false && m.score >= 6) prio.push(m);
  const picked = [];
  let total = 0;
  for (const m of prio) {
    const s = snapToSpeech(Math.max(0, m.start - 1.5), segs, -1), e = snapToSpeech(m.end + 1, segs, 1) + 0.6;
    const d = e - s;
    if (total + d - XF > maxSec) continue;
    picked.push({ ids: [m.id], start: s, end: e, titulo: m.titulo, score: m.score });
    total += d - XF;
  }
  // cronológico + unir tramos que se pisan o casi se tocan
  picked.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of picked) {
    const last = merged.at(-1);
    if (last && p.start - last.end < MERGE_GAP) {
      last.end = Math.max(last.end, p.end); last.ids.push(...p.ids);
      if (p.score > last.score) { last.titulo = p.titulo; last.score = p.score; }
    } else merged.push({ ...p });
  }
  // si al unir nos pasamos de 10 min, se saca el tramo de menor puntaje
  const len = () => merged.reduce((a, p) => a + (p.end - p.start), 0) - XF * Math.max(0, merged.length - 1);
  while (merged.length > 1 && len() > maxSec) merged.splice(merged.indexOf(merged.reduce((a, b) => (b.score < a.score ? b : a))), 1);
  return merged;
}

export async function buildSummary(vodId, { render = true, ids } = {}, ctx) {
  const { meta, moments } = loadAnalysis(vodId);
  if (!moments.length) throw new Error("Primero analizá el directo.");
  await checkOllama();
  const pool = moments.filter((m) => m.keep !== false).sort((a, b) => b.score - a.score).slice(0, 30);
  let plan;
  if (aiAvailable()) {
    ctx.progress(0.03, "La IA está armando el resumen del directo…");
    plan = await summarizeStream({ streamTitle: meta.title, game: meta.game, duration: meta.duration, moments: pool, timeline: chatTimeline(vodId), maxMinutes: MAX_SUMMARY_SEC / 60 });
  } else {
    plan = { titulo: `${meta.title} | Resumen del directo`, descripcion: "Los mejores momentos del directo.", resumen: "", orden: pool.map((m) => m.id), tags: ["overwatch", "twitch", "stream"], miniatura_texto: "MEJORES MOMENTOS" };
  }
  if (ids?.length) plan.orden = ids.map(Number);

  ctx.progress(0.08, "Buscando cortes limpios (pausas entre frases)…");
  const segs = allSegments(vodId, moments);
  const parts = planSegments(moments, plan.orden || [], segs);
  if (!parts.length) throw new Error("No hay momentos para el resumen.");
  const pl = await getPlaylists(vodId);
  for (const p of parts) {
    if (ctx.cancelled) return null;
    p.start = await quietestNear(pl.audio, p.start, 1.2, 0.3);
    p.end = await quietestNear(pl.audio, p.end, 0.3, 1.5);
  }

  const estimate = parts.reduce((a, p) => a + p.end - p.start, 0) - XF * (parts.length - 1);
  const chaptersFrom = (durs) => { let t = 0; return parts.map((p, i) => { const c = { t: Math.max(0, t), titulo: p.titulo }; t += durs[i] - XF; return c; }); };
  let chapters = chaptersFrom(parts.map((p) => p.end - p.start));
  const describe = () => {
    const chapterText = chapters.map((c, i) => `${i === 0 ? "0:00" : fmtShort(c.t)} ${String(c.titulo || "").replace(/[#]/g, "")}`).join("\n");
    const hashtags = pickHashtags(plan.tags?.slice(0, 3) || [], "shorts", 10).filter((h) => h !== "#Shorts");
    return `${plan.descripcion}\n\n📺 Directo original: https://www.twitch.tv/videos/${vodId}\n\n⏱️ Capítulos:\n${chapterText}\n\n${hashtags.join(" ")}`;
  };
  const summary = { ...plan, segments: parts.map((p) => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2), ids: p.ids, titulo: p.titulo })), duration: +estimate.toFixed(1), chapters, description: describe(), createdAt: new Date().toISOString(), file: null };
  writeJson(path.join(streamDir(vodId), "summary.json"), summary);
  ctx.log(`Resumen: ${parts.length} tramos, ~${fmt(estimate)} (máx ${MAX_SUMMARY_SEC / 60} min)`);
  if (!render) return summary;

  const folder = outFolder(meta);
  const work = path.join(streamDir(vodId), "work", "resumen");
  fs.mkdirSync(work, { recursive: true });
  const files = [], durs = [];
  for (let k = 0; k < parts.length; k++) {
    if (ctx.cancelled) return summary;
    const p = parts[k];
    const f = path.join(work, `part_${String(k).padStart(2, "0")}.mp4`);
    ctx.progress(0.1 + 0.65 * (k / parts.length), `Cortando tramo ${k + 1}/${parts.length} (${fmt(p.start)})…`);
    await renderHorizontal({ url: pl.source, start: p.start, end: p.end, outFile: f, fades: false, onProgress: (x) => ctx.progress(0.1 + 0.65 * ((k + x) / parts.length)) });
    files.push(f); durs.push(await probeDuration(f) || p.end - p.start);
  }
  ctx.progress(0.76, "Uniendo con transiciones suaves…");
  const name = `RESUMEN_${slug(plan.titulo)}`;
  const out = path.join(folder, `${name}.mp4`);
  await joinWithCrossfade(files, durs, out, { xf: XF, onProgress: (x) => ctx.progress(0.76 + 0.23 * x) });
  chapters = chaptersFrom(durs);
  summary.chapters = chapters;
  summary.description = describe();
  summary.duration = +(await probeDuration(out)).toFixed(1);
  fs.writeFileSync(path.join(folder, `${name}.txt`), `TÍTULO:\n${plan.titulo}\n\nDESCRIPCIÓN:\n${summary.description}\n\nTAGS:\n${(plan.tags || []).join(", ")}\n\nTEXTO MINIATURA: ${plan.miniatura_texto}\n\nRESUMEN:\n${plan.resumen}\n`, "utf8");
  for (const f of files) fs.rmSync(f, { force: true });
  summary.file = out;
  writeJson(path.join(streamDir(vodId), "summary.json"), summary);
  return summary;
}

function fmtShort(s) { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; }
