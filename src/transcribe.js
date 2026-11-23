// Transcripción local con Whisper (transformers.js, corre en tu CPU, sin enviar audio a ningún lado).
import path from "node:path";
import fs from "node:fs";
import { getConfig, DATA_DIR } from "./config.js";

let asrPromise = null;
let loadedModel = null;

export async function getAsr(onStatus, onDownload) {
  const model = getConfig().whisperModel;
  if (asrPromise && loadedModel === model) return asrPromise;
  loadedModel = model;
  asrPromise = (async () => {
    const tf = await import("@huggingface/transformers");
    tf.env.cacheDir = path.join(DATA_DIR, "models");
    onStatus?.(whisperCached() ? "Cargando modelo de voz…" : `Bajando modelo de voz ${model} (~250 MB, solo la primera vez)…`);
    return tf.pipeline("automatic-speech-recognition", model, { dtype: "q8", progress_callback: onDownload });
  })();
  asrPromise.catch(() => { asrPromise = null; });
  return asrPromise;
}

/**
 * Transcribe audio Float32 16 kHz. Devuelve [{ start, end, text }] con tiempos absolutos (offset sumado).
 */
export async function transcribe(samples, offsetSec = 0, onStatus) {
  if (!samples?.length) return [];
  const asr = await getAsr(onStatus);
  const out = await asr(samples, {
    language: getConfig().language || "spanish",
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const chunks = out.chunks || [{ timestamp: [0, samples.length / 16000], text: out.text }];
  return chunks
    .map((c) => ({
      start: +(offsetSec + (c.timestamp?.[0] ?? 0)).toFixed(2),
      end: +(offsetSec + (c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 3)).toFixed(2),
      text: (c.text || "").trim(),
    }))
    .filter((c) => c.text && !/^(\[.*\]|\(.*\)|subtítulos.*amara.*)$/i.test(c.text) || /risa|jaja/i.test(c.text));
}

export function transcriptToText(segs) {
  const fmt = (s) => { const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(x).padStart(2, "0")}`; };
  return segs.map((s) => `[${fmt(s.start)} = ${Math.round(s.start)}s] ${s.text}`).join("\n");
}

/** ¿El modelo de voz ya está descargado? */
export function whisperCached() {
  const dir = path.join(DATA_DIR, "models", ...getConfig().whisperModel.split("/"));
  try { const f = fs.readdirSync(path.join(dir, "onnx")); return f.some((x) => x.startsWith("encoder")) && f.some((x) => x.startsWith("decoder")); } catch { return false; }
}
