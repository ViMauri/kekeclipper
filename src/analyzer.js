// Pipeline completo: chat + audio (por streaming) → candidatos → transcripción → juicio de Claude → clips.
import fs from "node:fs";
import path from "node:path";
import { getConfig, streamDir, readJson, writeJson } from "./config.js";
import { vodInfo, fetchChat, getPlaylists } from "./twitch.js";
import { readAudio } from "./media.js";
import { chatSeries, audioFeatures, findCandidates, chatInWindow, chatMessageWeight } from "./signals.js";
import { transcribe, transcriptToText } from "./transcribe.js";
import { aiAvailable, aiProvider, judgeMoments, scanTranscriptBlock, batchSize, checkOllama } from "./ai.js";

const CHUNK = 600; // 10 minutos por tramo de audio

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export function loadAnalysis(vodId) {
  const d = streamDir(vodId);
  return {
    meta: readJson(path.join(d, "meta.json")),
    moments: readJson(path.join(d, "moments.json"), []),
    curve: readJson(path.join(d, "curve.json")),
    summary: readJson(path.join(d, "summary.json")),
  };
}

export function saveMoments(vodId, moments) {
  writeJson(path.join(streamDir(vodId), "moments.json"), moments);
}

/**
 * opts: { maxClips: number|"auto", deep: boolean, reuse: boolean }
 */
export async function analyzeVod(vodId, opts, ctx) {
  const cfg = getConfig();
  const dir = streamDir(vodId);
  const deep = Boolean(opts.deep);

  // 1) Info
  await checkOllama();
  ctx.log(`IA para el humor: ${aiProvider() === "claude" ? "Claude" : aiProvider() === "ollama" ? "local (" + cfg.ollamaModel + ")" : "ninguna (solo señales)"}`);
  ctx.progress(0.01, "Leyendo info del directo…");
  const meta = await vodInfo(vodId);
  writeJson(path.join(dir, "meta.json"), { ...meta, analyzedAt: new Date().toISOString(), deep });
  const duration = meta.duration;

  // 2) Chat
  let chat = opts.reuse ? readJson(path.join(dir, "chat.json")) : null;
  if (!chat) {
    ctx.progress(0.02, "Bajando la repetición del chat (solo texto)…");
    try {
      chat = await fetchChat(vodId, duration, (t, n) => ctx.progress(0.02 + 0.18 * (t / duration), `Chat: ${n} mensajes hasta ${fmt(t)}`));
    } catch (e) { ctx.log("No pude leer el chat: " + e.message); chat = []; }
    writeJson(path.join(dir, "chat.json"), chat);
  }
  ctx.log(`Chat: ${chat.length} mensajes`);
  if (ctx.cancelled) return;

  // 3) Audio por streaming (sin descargar la VOD), por tramos de 10 min
  const pl = await getPlaylists(vodId);
  let audio = opts.reuse ? readJson(path.join(dir, "audio.json")) : null;
  let transcriptAll = opts.reuse ? readJson(path.join(dir, "transcript.json")) : null;
  if (!audio || (deep && !transcriptAll)) {
    const sr = deep ? 16000 : 8000;
    const starts = [];
    for (let s = 0; s < duration; s += CHUNK) starts.push(s);
    const loud = [], laugh = [];
    transcriptAll = deep ? [] : transcriptAll;
    let done = 0;
    const conc = deep ? 1 : 3;
    ctx.progress(0.2, `Escuchando el audio del directo (${starts.length} tramos de 10 min)…`);
    const parts = await pool(starts, conc, async (s) => {
      if (ctx.cancelled) return null;
      const url = (await getPlaylists(vodId)).audio;
      const samples = await readAudio(url, s, Math.min(CHUNK, duration - s), sr);
      const feats = audioFeatures(samples, sr);
      let tr = [];
      if (deep) {
        tr = await transcribe(samples, s, (m) => ctx.progress(null, m));
      }
      done++;
      ctx.progress(0.2 + 0.4 * (done / starts.length), `Audio: ${fmt(Math.min(duration, done * CHUNK))} de ${fmt(duration)}${deep ? " (transcribiendo todo)" : ""}`);
      return { s, feats, tr };
    });
    if (ctx.cancelled) return;
    for (const p of parts.filter(Boolean).sort((a, b) => a.s - b.s)) {
      loud.push(...p.feats.loud); laugh.push(...p.feats.laugh);
      if (deep) transcriptAll.push(...p.tr);
    }
    audio = { loud: loud.map((x) => +x.toFixed(1)), laugh: laugh.map((x) => +x.toFixed(3)) };
    writeJson(path.join(dir, "audio.json"), audio);
    if (deep) writeJson(path.join(dir, "transcript.json"), transcriptAll);
  }

  // 4) Candidatos
  const series = chatSeries(chat, duration, 5);
  const target = opts.maxClips === "auto" || !opts.maxClips ? Math.min(25, Math.max(3, Math.ceil(duration / 1200))) : Number(opts.maxClips);
  const { curve, candidates } = findCandidates({
    duration, chat: series, audio, chatDelaySec: cfg.chatDelaySec,
    maxCandidates: Math.min(60, target * 3 + 5),
  });
  writeJson(path.join(dir, "curve.json"), { bin: 5, curve, chatRate: series.rate, chatHumor: series.humor });
  ctx.log(`${candidates.length} momentos candidatos`);

  // 5) Modo profundo: Claude lee toda la transcripción y suma momentos que el chat no marcó
  if (deep && aiAvailable() && transcriptAll?.length) {
    const blocks = [];
    for (let s = 0; s < duration; s += CHUNK) blocks.push(s);
    let k = 0;
    for (const s of blocks) {
      if (ctx.cancelled) return;
      ctx.progress(0.6 + 0.1 * (k++ / blocks.length), `La IA lee la charla completa: tramo ${k}/${blocks.length}`);
      const segs = transcriptAll.filter((x) => x.start >= s && x.start < s + CHUNK);
      if (segs.length < 3) continue;
      const laughs = chat.filter((m) => m.t >= s && m.t < s + CHUNK && chatMessageWeight(m.text) >= 2).slice(0, 60);
      try {
        const found = await scanTranscriptBlock({ transcript: transcriptToText(segs), chat: laughs, blockStart: s, blockEnd: s + CHUNK, minSec: cfg.minClipSec, maxSec: cfg.maxClipSec, streamTitle: meta.title });
        for (const f of found) {
          const peak = (f.start + f.end) / 2;
          if (!candidates.some((c) => Math.abs(c.peak - peak) < 40)) candidates.push({ peak, signal: +(f.score / 3).toFixed(2), chatHumor: 0, audioLaugh: 0, fromTranscript: true });
        }
      } catch (e) { ctx.log("Bloque " + k + ": " + e.message); }
    }
    candidates.sort((a, b) => a.peak - b.peak);
  }

  // 6) Contexto de cada candidato (transcripción local de la ventana)
  const items = [];
  let i = 0;
  // Las ventanas ya transcriptas se guardan para que re-analizar no vuelva a escuchar todo
  const winFile = path.join(dir, "windows.json");
  const winCache = opts.reuse ? readJson(winFile, {}) : {};
  for (const c of candidates) {
    if (ctx.cancelled) return;
    i++;
    const wStart = Math.max(0, c.peak - 50), wEnd = Math.min(duration, c.peak + 20);
    ctx.progress(0.7 + 0.12 * (i / candidates.length), `Escuchando momento ${i}/${candidates.length} (${fmt(c.peak)})…`);
    let segs;
    const key = `${Math.round(wStart)}-${Math.round(wEnd)}`;
    if (transcriptAll?.length) segs = transcriptAll.filter((x) => x.end >= wStart && x.start <= wEnd);
    else if (winCache[key]) segs = winCache[key];
    else {
      try {
        const samples = await readAudio((await getPlaylists(vodId)).audio, wStart, wEnd - wStart, 16000);
        segs = await transcribe(samples, wStart, (m) => ctx.progress(null, m));
        winCache[key] = segs;
        writeJson(winFile, winCache);
      } catch (e) { ctx.log("Transcripción falló en " + fmt(c.peak) + ": " + e.message); segs = []; }
    }
    items.push({ id: i, ...c, windowStart: wStart, windowEnd: wEnd, segs, transcript: transcriptToText(segs), chat: chatInWindow(chat, wStart, wEnd + 10) });
  }

  // 7) Juicio de humor
  let judged = [];
  if (aiAvailable()) {
    const batches = [];
    const bs = batchSize();
    for (let k = 0; k < items.length; k += bs) batches.push(items.slice(k, k + bs));
    let b = 0;
    for (const batch of batches) {
      if (ctx.cancelled) return;
      ctx.progress(0.82 + 0.13 * (b++ / batches.length), `${aiProvider() === "ollama" ? "IA local" : "Claude"} analizando el humor (lote ${b}/${batches.length})…`);
      try {
        const res = await judgeMoments(batch, { minSec: cfg.minClipSec, maxSec: cfg.maxClipSec, streamTitle: meta.title, game: meta.game });
        judged.push(...res);
      } catch (e) { ctx.log("Lote " + b + ": " + e.message); judged.push(...batch.map(heuristicJudge)); }
    }
    // Segunda pasada: los que necesitan más contexto (chistes que arrancaron antes)
    const need = judged.filter((j) => j.needs_more_context && j.score >= 5);
    if (need.length) ctx.progress(0.95, `Revisando ${need.length} chistes con más contexto…`);
    for (const j of need) {
      if (ctx.cancelled) return;
      const it = items.find((x) => x.id === j.id);
      const wStart = Math.max(0, it.peak - 150), wEnd = Math.min(duration, it.peak + 20);
      try {
        let segs = transcriptAll?.length ? transcriptAll.filter((x) => x.end >= wStart && x.start <= wEnd) : await transcribe(await readAudio((await getPlaylists(vodId)).audio, wStart, wEnd - wStart, 16000), wStart);
        const it2 = { ...it, windowStart: wStart, windowEnd: wEnd, segs, transcript: transcriptToText(segs), chat: chatInWindow(chat, wStart, wEnd + 10, 120) };
        const [r] = await judgeMoments([it2], { minSec: cfg.minClipSec, maxSec: Math.max(cfg.maxClipSec, 59), streamTitle: meta.title, game: meta.game });
        if (r) { Object.assign(j, r, { id: j.id }); it.segs = segs; }
      } catch (e) { ctx.log("Contexto extra falló: " + e.message); }
    }
  } else {
    ctx.log("Sin API key de Claude: uso puntaje heurístico (configurala para juzgar el humor de verdad).");
    judged = items.map(heuristicJudge);
  }

  // 8) Selección final ("x" clips según calidad)
  const moments = items.map((it) => {
    const j = judged.find((x) => x.id === it.id) || heuristicJudge(it);
    let start = clamp(j.start, 0, duration), end = clamp(j.end, 0, duration);
    // tiempos absurdos (fuera de la ventana escuchada) → corte por defecto alrededor del pico
    if (!(end > start) || end < it.windowStart - 5 || start > it.windowEnd + 15) { start = it.peak - 25; end = it.peak + 8; }
    // muy corto: se agrega contexto sobre todo ANTES (el arranque del chiste) y un poco después (la risa)
    if (end - start < cfg.minClipSec) { const falta = cfg.minClipSec - (end - start); start -= falta * 0.7; end += falta * 0.3; }
    // muy largo: se recorta desde el principio, el remate y la risa quedan
    if (end - start > cfg.maxClipSec) start = end - cfg.maxClipSec;
    start = clamp(start, 0, duration); end = clamp(end, 0, duration);
    return {
      id: it.id, peak: it.peak, signal: it.signal, chatHumor: it.chatHumor, audioLaugh: it.audioLaugh,
      start: +start.toFixed(1), end: +end.toFixed(1),
      score: +(+j.score).toFixed(1), keep: j.keep, tipo: j.tipo, titulo: j.titulo, gancho: j.gancho, descripcion: j.descripcion,
      hashtags: j.hashtags || [], por_que: j.por_que, transcript: it.transcript, aiJudged: !j.heuristic,
      layout: cfg.defaultLayout, cropX: 0.5, selected: false, rendered: null,
    };
  });
  const ranked = [...moments].filter((m) => m.keep !== false).sort((a, b) => b.score - a.score);
  let chosen;
  if (opts.maxClips === "auto" || !opts.maxClips) {
    chosen = ranked.filter((m) => m.score >= 7);
    if (chosen.length < 3) chosen = ranked.slice(0, 3);
    chosen = chosen.slice(0, target);
  } else chosen = ranked.slice(0, target);
  for (const m of chosen) m.selected = true;

  saveMoments(vodId, moments);
  ctx.progress(1, `Listo: ${chosen.length} clips recomendados de ${moments.length} momentos analizados.`);
  return { vodId, recommended: chosen.length, analyzed: moments.length };
}

function heuristicJudge(it) {
  const s = Math.min(10, 4 + it.signal * 1.5);
  return {
    id: it.id, keep: true, score: +s.toFixed(1), tipo: "reaccion", needs_more_context: false,
    start: Math.max(0, it.peak - 25), end: it.peak + 8,
    titulo: `Momento épico ${fmt(it.peak)} 😂`, gancho: "ESPERÁ AL FINAL", descripcion: "Momento del directo.", hashtags: [], por_que: "Pico de risas en chat/audio (sin IA)", heuristic: true,
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
export function fmt(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }

export function chatTimeline(vodId) {
  const chat = readJson(path.join(streamDir(vodId), "chat.json"), []);
  if (!chat.length) return "(sin chat)";
  const stop = new Set("de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo tuya tuyos tuyas suyo suya suyos suyas nuestro nuestra nuestros nuestras vosotros es son q xq pq jaja jajaja xd kekw lul".split(" "));
  const blocks = new Map();
  for (const m of chat) {
    const b = Math.floor(m.t / 900);
    if (!blocks.has(b)) blocks.set(b, new Map());
    const map = blocks.get(b);
    for (const w of m.text.toLowerCase().split(/[^a-záéíóúñü0-9]+/)) if (w.length > 3 && !stop.has(w)) map.set(w, (map.get(w) || 0) + 1);
  }
  return [...blocks.entries()].map(([b, map]) => `${fmt(b * 900)}: ${[...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map((x) => x[0]).join(", ")}`).join("\n");
}

export function hasAnalysis(vodId) {
  return fs.existsSync(path.join(streamDir(vodId), "moments.json"));
}
