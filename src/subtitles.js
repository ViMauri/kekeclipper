// Subtítulos estilo Shorts (.ass): palabras grandes, en mayúsculas, de a 2-3 palabras + título (gancho) arriba.
const STYLES = {
  amarillo: { primary: "&H0000F0FF", outline: "&H00000000" },
  blanco: { primary: "&H00FFFFFF", outline: "&H00000000" },
  verde: { primary: "&H0066FF66", outline: "&H00000000" },
};

/** Altura por defecto de los subtítulos (en píxeles de 1920) según el formato. */
export function defaultSubY(layout) { return layout === "facecam" ? 1160 : layout === "crop" ? 1350 : 1480; }

function ts(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
// La fuente del video no tiene emojis: se sacan para que no aparezcan cuadraditos.
const esc = (s) => String(s).replace(/[{}\\]/g, "").replace(/\n/g, " ").replace(/\p{Extended_Pictographic}|️|‍/gu, "").replace(/\s{2,}/g, " ").trim();

/** Acorta gritos ("AAAAAAAA", "JAJAJAJAJA") y palabras eternas para que entren en pantalla. */
export function cleanWords(text) {
  return String(text || "")
    .replace(/(\p{L})\1{3,}/gu, "$1$1$1$1$1")
    .replace(/(\p{L}{2})\1{3,}/gu, "$1$1$1")
    .split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 14 ? w.slice(0, 13) + "…" : w));
}

/**
 * segs: [{start,end,text}] con tiempos RELATIVOS al inicio del clip.
 * mode "auto": parte cada frase en grupos de 2-3 palabras (estilo Shorts).
 *      "line": muestra cada línea tal cual la escribió el usuario (si es larga, en 2 renglones).
 * hook: texto del título arriba (null = sin título). hookDur: segundos (0 = todo el clip).
 * subY / hookY: altura del centro del texto en píxeles (0-1920). subScale: tamaño en % (100 = normal).
 */
export function buildAss({ segs = [], hook, hookDur = 4, duration, style = "amarillo", layout = "blur", subY, hookY = 250, subScale = 100, mode = "auto" }) {
  const st = STYLES[style] || STYLES.amarillo;
  const y = Math.round(subY ?? defaultSubY(layout));
  const lines = [];
  const dialog = (a, b, k, text, anim = true) => {
    a = Math.max(0, a); b = Math.min(duration, b);
    if (b <= a + 0.05) return;
    const tag = anim ? `\\fscx${k + 5}\\fscy${k + 5}\\t(0,90,\\fscx${k}\\fscy${k})` : `\\fscx${k}\\fscy${k}`;
    lines.push(`Dialogue: 0,${ts(a)},${ts(b)},Sub,,0,0,0,,{\\pos(540,${y})${tag}}${text}`);
  };
  for (const s of segs) {
    const words = cleanWords(s.text);
    if (!words.length) continue;
    if (mode === "line") {
      // Texto escrito por el usuario: se respeta tal cual, en bloques de hasta 2 renglones de ~18 letras
      const rows = [];
      for (const w of words) {
        const last = rows.at(-1);
        if (last && (last + " " + w).length <= 18) rows[rows.length - 1] = last + " " + w; else rows.push(w);
      }
      const blocks = [];
      for (let i = 0; i < rows.length; i += 2) blocks.push(rows.slice(i, i + 2));
      const span = (s.end - s.start) / blocks.length;
      blocks.forEach((b, i) => {
        const longest = Math.max(...b.map((r) => r.length));
        const fit = Math.max(60, Math.min(100, Math.round((18 / Math.max(18, longest)) * 100)));
        dialog(s.start + i * span, s.start + (i + 1) * span, Math.round(fit * subScale / 100), b.map((r) => esc(r.toUpperCase())).join("\\N"), false);
      });
      continue;
    }
    const groups = [];
    for (let i = 0; i < words.length;) {
      let g = words[i++];
      while (i < words.length && g.split(" ").length < 3 && (g + " " + words[i]).length <= 18) g += " " + words[i++];
      groups.push(g);
    }
    const span = Math.max(0.3, (s.end - s.start) / groups.length);
    groups.forEach((g, k) => {
      const fit = Math.max(55, Math.min(100, Math.round((17 / Math.max(17, g.length)) * 100)));
      dialog(s.start + k * span, s.start + (k + 1) * span, Math.round(fit * subScale / 100), esc(g.toUpperCase()));
    });
  }
  if (hook) {
    const end = hookDur > 0 ? Math.min(hookDur, duration) : duration;
    lines.unshift(`Dialogue: 1,${ts(0)},${ts(end)},Hook,,0,0,0,,{\\pos(540,${Math.round(hookY)})\\fad(150,${hookDur > 0 ? 250 : 0})}${esc(hook.toUpperCase())}`);
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Arial Black,86,${st.primary},&H000000FF,${st.outline},&H80000000,1,0,0,0,100,100,0,0,1,7,3,5,40,40,0,1
Style: Hook,Arial Black,78,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}
