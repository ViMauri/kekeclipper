// Señales de "momento gracioso": chat (humor rioplatense / andino / latino) + audio (risas, gritos).

// ---------- Léxico de risa y reacción del chat latino ----------
// Peso alto = risa clara. Incluye variantes de Argentina, Uruguay, Perú, Chile, México, Colombia.
const LAUGH_PATTERNS = [
  [/\b(?:j+a+){2,}j*\b|\bja(?:ja)+\b|\bjaj+a*\b/i, 3],          // jajaja, jajsja
  [/\bj[ajsk]{4,}\b/i, 3],                                       // jsjsjs, jajsjsja, jakajka
  [/\b(?:a?ja?sj[ajs]*)\b/i, 2],
  [/\bk{3,}j*\b|\bkjk+\b/i, 2],                                  // kkkk (brasileños en el chat)
  [/\b(?:x+d+|xd)\b/i, 1.5],
  [/\b(?:lol|lmao|lmfao)\b/i, 1.5],
  [/\b(?:me\s*(?:meo|cago|muero|mato|orino|parto)|me\s*descost)/i, 3],
  [/\blpm+\b|\bla\s*puta\s*madre\b|\blpmqlp\b|\bqlp\b/i, 2],     // arg / uy
  [/\bnmms\b|\bno\s*mames\b|\bnmamut/i, 2],                       // mx
  [/\bcsm\b|\bconchasumare\b|\bcausa\b/i, 1],                     // pe
  [/\bctm+\b|\bconchetumare\b|\bweon\b|\bweona\b/i, 1],           // cl
  [/\bboludo\b|\bbolu\b|\bnaaa+\b|\bnooo+\b|\bbro+\b/i, 1],
  [/\bmuerto\b|\bmorí\b|\bmori\b|\bdead\b|\bimposible\b|\bclip\b|\bclipea\w*|\bclipp?\w*/i, 2],
  [/\bkekw\b|\bomegalul\b|\blul\b|\blulw\b|\bicant\b|\bpepelaugh\b|\bkek\b|\blmao\b|\bwheeze\b|\bkekl\b|\bpepela\b/i, 2],
  [/[😂🤣💀😹😭]/u, 2],
];

export function chatMessageWeight(text) {
  if (!text) return 0;
  let w = 0;
  for (const [re, pts] of LAUGH_PATTERNS) if (re.test(text)) w += pts;
  // MAYÚSCULAS sostenidas = reacción fuerte
  const letters = text.replace(/[^a-záéíóúñ]/gi, "");
  if (letters.length >= 5 && letters === letters.toUpperCase()) w += 0.7;
  const emojiLaughs = (text.match(/[😂🤣💀]/gu) || []).length;
  w += Math.min(emojiLaughs, 5) * 0.3;
  return Math.min(w, 8);
}

/** Series por bins de `bin` segundos: humor del chat y ritmo de mensajes. */
export function chatSeries(messages, duration, bin = 5) {
  const n = Math.ceil(duration / bin) + 1;
  const humor = new Float32Array(n);
  const rate = new Float32Array(n);
  for (const m of messages) {
    const i = Math.floor(m.t / bin);
    if (i < 0 || i >= n) continue;
    rate[i] += 1;
    humor[i] += chatMessageWeight(m.text);
  }
  return { bin, humor: Array.from(humor), rate: Array.from(rate) };
}

// ---------- Audio ----------
/**
 * A partir del audio PCM (mono, Float32), calcula por segundo:
 *  - loud: energía en dB
 *  - laugh: "risa probable" = energía alta + modulación rítmica 3–8 Hz (el "ja-ja-ja")
 *    + muchos picos cortos. Es heurístico: la confirmación la hace la transcripción + Claude.
 */
export function audioFeatures(samples, sampleRate) {
  const hop = Math.round(sampleRate / 50); // 20 ms
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * hop;
    for (let k = 0; k < hop; k++) { const v = samples[o + k]; s += v * v; }
    env[f] = Math.sqrt(s / hop);
  }
  const secs = Math.floor(frames / 50);
  const loud = new Array(secs);
  const laugh = new Array(secs);
  for (let s = 0; s < secs; s++) {
    // ventana de 2 s centrada para la modulación
    const a = Math.max(0, (s - 0.5) * 50) | 0, b = Math.min(frames, (s + 1.5) * 50) | 0;
    let mean = 0;
    for (let f = s * 50; f < (s + 1) * 50; f++) mean += env[f];
    mean /= 50;
    loud[s] = 20 * Math.log10(mean + 1e-6);
    // modulación: autocorrelación de la envolvente en lags 6–17 frames (≈ 3–8 Hz)
    const seg = env.subarray(a, b);
    const len = seg.length;
    let mu = 0; for (let i = 0; i < len; i++) mu += seg[i]; mu /= len || 1;
    let v0 = 0; for (let i = 0; i < len; i++) v0 += (seg[i] - mu) ** 2;
    let best = 0;
    for (let lag = 6; lag <= 17; lag++) {
      let c = 0; for (let i = lag; i < len; i++) c += (seg[i] - mu) * (seg[i - lag] - mu);
      best = Math.max(best, c / (v0 + 1e-9));
    }
    // picos cortos (ráfagas)
    let peaks = 0;
    for (let i = 1; i < len - 1; i++) if (seg[i] > seg[i - 1] && seg[i] > seg[i + 1] && seg[i] > mu * 1.6) peaks++;
    const burst = Math.min(peaks / 12, 1);
    laugh[s] = Math.max(0, best) * 0.6 + burst * 0.4;
  }
  return { loud, laugh };
}

// ---------- Combinación y picos ----------
function rollingZ(arr, win) {
  const out = new Array(arr.length).fill(0);
  let sum = 0, sq = 0;
  const q = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] || 0;
    q.push(v); sum += v; sq += v * v;
    if (q.length > win) { const o = q.shift(); sum -= o; sq -= o * o; }
    const m = sum / q.length;
    const sd = Math.sqrt(Math.max(sq / q.length - m * m, 1e-6));
    out[i] = (v - m) / (sd + 0.25);
  }
  return out;
}

function toBins(perSecond, bin, reduce = "max") {
  const n = Math.ceil(perSecond.length / bin);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const sl = perSecond.slice(i * bin, (i + 1) * bin);
    if (!sl.length) continue;
    out[i] = reduce === "max" ? Math.max(...sl) : sl.reduce((a, b) => a + b, 0) / sl.length;
  }
  return out;
}

/**
 * Devuelve la curva combinada por bin y los picos candidatos.
 * chatDelaySec: corre el chat hacia atrás (la gente escribe "JAJAJA" unos segundos después).
 */
export function findCandidates({ duration, chat, audio, chatDelaySec = 6, maxCandidates = 40, minGapSec = 50 }) {
  const bin = 5;
  const n = Math.ceil(duration / bin) + 1;
  const shift = Math.round(chatDelaySec / bin);
  const hasChat = chat && chat.humor.some((x) => x > 0);
  const hasAudio = audio && audio.loud?.length > 0;

  const humorZ = hasChat ? rollingZ(chat.humor, 120) : [];
  const rateZ = hasChat ? rollingZ(chat.rate, 120) : [];
  const loudZ = hasAudio ? rollingZ(toBins(audio.loud, bin, "max"), 120) : [];
  const laughB = hasAudio ? toBins(audio.laugh, bin, "max") : [];
  const laughZ = hasAudio ? rollingZ(laughB, 120) : [];

  const score = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const j = i + shift; // el chat del futuro cercano explica este momento
    const c = hasChat ? Math.max(0, humorZ[j] ?? 0) * 0.75 + Math.max(0, rateZ[j] ?? 0) * 0.25 : 0;
    const a = hasAudio ? Math.max(0, laughZ[i] ?? 0) * 0.6 + Math.max(0, loudZ[i] ?? 0) * 0.4 : 0;
    score[i] = hasChat && hasAudio ? c * 0.6 + a * 0.4 : hasChat ? c : a;
  }
  // suavizado leve
  const smooth = score.map((_, i) => (score[i - 1] ?? 0) * 0.25 + score[i] * 0.5 + (score[i + 1] ?? 0) * 0.25);

  // supresión de no-máximos
  const idx = smooth.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const picked = [];
  const gap = Math.ceil(minGapSec / bin);
  for (const [v, i] of idx) {
    if (v < 0.8 || picked.length >= maxCandidates) break;
    if (picked.some((p) => Math.abs(p.i - i) < gap)) continue;
    picked.push({ i, v });
  }
  const candidates = picked.map(({ i, v }) => ({
    peak: i * bin + bin / 2,
    signal: +v.toFixed(2),
    chatHumor: hasChat ? +(chat.humor.slice(i, i + shift + 3).reduce((a, b) => a + b, 0)).toFixed(1) : 0,
    audioLaugh: hasAudio ? +(laughB[i] ?? 0).toFixed(2) : 0,
  })).sort((a, b) => a.peak - b.peak);
  return { bin, curve: smooth.map((x) => +x.toFixed(2)), candidates };
}

export function chatInWindow(messages, a, b, max = 80) {
  const sel = messages.filter((m) => m.t >= a && m.t <= b);
  if (sel.length <= max) return sel;
  const step = sel.length / max;
  return Array.from({ length: max }, (_, k) => sel[Math.floor(k * step)]);
}
