// FFmpeg: lee directo de la playlist HLS de Twitch (solo el tramo pedido) y arma Shorts / resúmenes.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OUT_W, OUT_H, normalizeFrame } from "./framing.js";

/**
 * Busca ffmpeg aunque el PATH de esta ventana esté desactualizado
 * (pasa si se instaló con winget después de abrir la terminal/el explorador).
 */
function findFfmpeg() {
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // 1) PATH actual + PATH guardado en el registro (usuario y sistema)
  const dirs = (process.env.PATH || "").split(path.delimiter);
  if (process.platform === "win32") {
    for (const scope of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      try {
        const out = spawnSync("reg", ["query", scope, "/v", "Path"], { encoding: "utf8" }).stdout || "";
        const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out);
        if (m) dirs.push(...m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] || "").split(";"));
      } catch {}
    }
    // 2) Lugares típicos de instalación
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    dirs.push(path.join(local, "Microsoft", "WinGet", "Links"), "C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin", path.join(os.homedir(), "scoop", "shims"), "C:\\ProgramData\\chocolatey\\bin");
    const pk = path.join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const p of fs.readdirSync(pk).filter((d) => /ffmpeg/i.test(d))) {
        for (const sub of fs.readdirSync(path.join(pk, p))) dirs.push(path.join(pk, p, sub, "bin"));
      }
    } catch {}
  }
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d.trim(), exe);
    if (fs.existsSync(f)) return f;
  }
  return "ffmpeg";
}

let FFMPEG = findFfmpeg();
/** Vuelve a buscar ffmpeg (después de instalarlo desde la app). */
export function refreshFfmpeg() { FFMPEG = findFfmpeg(); return FFMPEG; }
const NET = ["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5", "-rw_timeout", "30000000"];

export function ffmpegAvailable() {
  return new Promise((res) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-version"]);
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
}

/** Lee `dur` segundos de audio desde `start` como Float32 mono (no guarda nada en disco). */
export function readAudio(url, start, dur, sampleRate = 16000) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", ...NET, "-ss", String(Math.max(0, start)), "-i", url, "-t", String(dur), "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"];
    const p = spawn(FFMPEG, args);
    const chunks = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (!buf.length && code !== 0) return reject(new Error("ffmpeg (audio): " + err.slice(-400)));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4));
      resolve(new Float32Array(ab));
    });
  });
}

function run(args, { cwd, onProgress, totalSec } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-y", "-progress", "pipe:2", "-nostats", ...args], { cwd });
    let err = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      const m = /out_time_us=(\d+)/.exec(s);
      if (m && onProgress && totalSec) onProgress(Math.min(1, +m[1] / 1e6 / totalSec));
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg falló: " + err.split("\n").filter((l) => !l.includes("=")).slice(-6).join(" | ")))));
  });
}

const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart"];

/** Recorte de un rectángulo (fracciones del video original) para ffmpeg. */
const cropOf = (r) => `crop=iw*${r.w}:ih*${r.h}:iw*${r.x}:ih*${r.y}`;

/**
 * Filtro de video para 9:16 (1080x1920). `frame` es el encuadre ya normalizado (src/framing.js):
 * cada zona trae su rectángulo con la proporción justa, así no se deforma nada.
 */
function verticalFilter(layout, frame) {
  if (layout === "crop") {
    return `[0:v]${cropOf(frame.crop)},scale=${OUT_W}:${OUT_H},setsar=1,fps=30[v0]`;
  }
  if (layout === "facecam") {
    const camH = frame.camH, gameH = OUT_H - camH;
    return [
      `[0:v]split=2[c][g]`,
      `[c]${cropOf(frame.cam)},scale=${OUT_W}:${camH}[cam]`,
      `[g]${cropOf(frame.game)},scale=${OUT_W}:${gameH}[game]`,
      `[cam][game]vstack=inputs=2,setsar=1,fps=30[v0]`,
    ].join(";");
  }
  // blur: fondo desenfocado + el video (con el zoom que elijas) centrado
  return [
    `[0:v]split=2[a][b]`,
    `[a]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=24:3,eq=brightness=-0.08[bg]`,
    `[b]${cropOf(frame.fg)},scale=${OUT_W}:-2[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2-80,setsar=1,fps=30[v0]`,
  ].join(";");
}

/**
 * Renderiza un Short vertical. Solo baja de Twitch el tramo [start, end].
 * assFile: subtítulos .ass (ruta absoluta, se usa nombre relativo para evitar líos de escape en Windows).
 */
export async function renderShort({ url, start, end, layout = "blur", frame, assFile, outFile, onProgress }) {
  const dur = Math.max(1, end - start);
  const cwd = path.dirname(assFile || outFile);
  let fc = verticalFilter(layout, normalizeFrame(frame));
  if (assFile && fs.existsSync(assFile)) fc += `;[v0]subtitles=${path.basename(assFile)}[v]`;
  else fc += `;[v0]null[v]`;
  const args = [...NET, "-ss", String(start), "-i", url, "-t", String(dur), "-filter_complex", fc, "-map", "[v]", "-map", "0:a?", ...ENC, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", outFile];
  await run(args, { cwd, onProgress, totalSec: dur });
  return outFile;
}

/**
 * Corta un tramo horizontal 1920x1080 (para el resumen de YouTube).
 * fades=false: corte seco (las transiciones se hacen después al unir). Audio normalizado para que no haya saltos de volumen.
 */
export async function renderHorizontal({ url, start, end, outFile, onProgress, fades = true }) {
  const dur = Math.max(1, end - start);
  const vf = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
  const fade = fades ? `,fade=t=in:st=0:d=0.4,fade=t=out:st=${(dur - 0.4).toFixed(2)}:d=0.4` : "";
  const af = (fades ? `afade=t=in:d=0.3,afade=t=out:st=${(dur - 0.4).toFixed(2)}:d=0.4,` : "") + "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";
  const args = [...NET, "-ss", String(start), "-i", url, "-t", String(dur), "-vf", vf + fade, "-af", af, "-ac", "2", ...ENC, outFile];
  await run(args, { onProgress, totalSec: dur });
  return outFile;
}

/** Duración de un archivo (segundos). */
export function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve(0));
    p.on("close", () => { const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err); resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0); });
  });
}

/**
 * Une varios tramos con una transición corta (crossfade de video y audio) para que el ritmo no se corte.
 * durations: duración real de cada archivo. xf: segundos de transición.
 */
export async function joinWithCrossfade(files, durations, outFile, { xf = 0.3, onProgress } = {}) {
  if (files.length === 1) { fs.copyFileSync(files[0], outFile); return outFile; }
  const inputs = files.flatMap((f) => ["-i", f]);
  const parts = [];
  let vPrev = "[0:v]", aPrev = "[0:a]", acc = durations[0];
  for (let i = 1; i < files.length; i++) {
    const off = Math.max(0, acc - xf * i).toFixed(3);
    const vo = i === files.length - 1 ? "[v]" : `[v${i}]`, ao = i === files.length - 1 ? "[a]" : `[a${i}]`;
    parts.push(`${vPrev}[${i}:v]xfade=transition=fade:duration=${xf}:offset=${off}${vo}`);
    parts.push(`${aPrev}[${i}:a]acrossfade=d=${xf}:c1=tri:c2=tri${ao}`);
    vPrev = vo; aPrev = ao; acc += durations[i];
  }
  const total = acc - xf * (files.length - 1);
  await run([...inputs, "-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", ...ENC, outFile], { onProgress, totalSec: total });
  return outFile;
}

export async function concatFiles(files, outFile) {
  const list = path.join(path.dirname(outFile), `concat_${Date.now()}.txt`);
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  try { await run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", outFile]); }
  finally { fs.rmSync(list, { force: true }); }
  return outFile;
}

/** Captura un frame (para miniaturas / ubicar la facecam). */
export async function grabFrame(url, at, outFile) {
  await run([...NET, "-ss", String(at), "-i", url, "-frames:v", "1", "-q:v", "3", "-vf", "scale=960:-2", outFile]);
  return outFile;
}
