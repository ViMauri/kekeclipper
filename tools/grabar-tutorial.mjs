// Graba el video tutorial de KekeClipper manejando la ventana de la app (WebView2) por su puerto de depuración.
// Uso: abrir KekeClipper.exe con WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y correr:
//   node tools/grabar-tutorial.mjs <carpeta_de_cuadros>
// Deja los cuadros + frames.txt (lista con duraciones) para armar el video con ffmpeg.
import fs from "node:fs";
import path from "node:path";

const PORT = 9333;
const OUT = path.resolve(process.argv[2] || "tutorial_frames");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const W = 1600, H = 900;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Conexión CDP ----------
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && t.url.includes("localhost:3939"));
if (!target) throw new Error("No encontré la ventana de KekeClipper");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else for (const l of listeners) l(m);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("JS: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// ---------- Captura (screencast) ----------
const frames = [];
let recording = false;
listeners.push((m) => {
  if (m.method !== "Page.screencastFrame") return;
  const { data, metadata, sessionId } = m.params;
  send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (!recording) return;
  const f = path.join(OUT, `f_${String(frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(f, Buffer.from(data, "base64"));
  frames.push({ f, t: metadata.timestamp });
});

await send("Page.enable");
await send("Runtime.enable");

// Arranque limpio: la verificación ya pasó (así no salta sola) y recargamos
await js(`sessionStorage.setItem("setupOk", "1"); location.hash = "#/"; true`);
await send("Page.reload");
await wait(3000);

// ---------- Capa del tutorial: cursor, textos y carteles ----------
const OVERLAY = `(() => {
  if (window.__demo) return true;
  const css = document.createElement("style");
  css.textContent = \`
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    #dCursor { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 99999; pointer-events: none; transition: left .7s cubic-bezier(.4,0,.2,1), top .7s cubic-bezier(.4,0,.2,1); filter: drop-shadow(0 2px 4px rgba(0,0,0,.7)); }
    #dCursor.fast { transition: none; }
    .dRipple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #e10600; z-index: 99998; pointer-events: none; animation: dRip .55s ease-out forwards; }
    @keyframes dRip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
    #dCap { position: fixed; left: 50%; bottom: 62px; transform: translateX(-50%) translateY(20px); max-width: 1180px; width: max-content; z-index: 99990; pointer-events: none;
      display: flex; gap: 16px; align-items: center; background: rgba(0,0,0,.93); border: 1px solid #333; border-left: 6px solid #e10600; border-radius: 14px; padding: 16px 24px;
      color: #fff; font: 600 25px/1.3 "Segoe UI", system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.7); opacity: 0; transition: opacity .35s, transform .35s; }
    #dCap.on { opacity: 1; transform: translateX(-50%) translateY(0); }
    #dCap .n { flex: none; background: #e10600; color: #fff; font-weight: 800; border-radius: 10px; padding: 4px 12px; font-size: 22px; }
    #dCard { position: fixed; inset: 0; z-index: 99995; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #fff; text-align: center;
      background: radial-gradient(circle at 50% 40%, #3a0000 0%, #0a0a0a 60%, #000 100%); font-family: "Segoe UI", system-ui, sans-serif; opacity: 0; transition: opacity .5s; pointer-events: none; }
    #dCard.on { opacity: 1; }
    #dCard img { width: 150px; height: 150px; border-radius: 34px; box-shadow: 0 0 60px rgba(225,6,0,.55); }
    #dCard h1 { font-size: 78px; margin: 8px 0 0; font-weight: 900; letter-spacing: -1px; } #dCard h1 b { color: #e10600; }
    #dCard p { font-size: 30px; margin: 0; color: #ddd; } #dCard small { font-size: 22px; color: #aaa; margin-top: 18px; }
    #dCard .tw { color: #fff; border: 2px solid #e10600; border-radius: 99px; padding: 6px 18px; font-size: 24px; }
  \`;
  document.head.appendChild(css);
  const c = document.createElement("div");
  c.id = "dCursor";
  c.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2 L4 20 L9 15.5 L12.5 22.5 L15.5 21 L12 14.2 L19 14.2 Z" fill="#fff" stroke="#e10600" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  c.style.left = "800px"; c.style.top = "450px";
  document.body.appendChild(c);
  const cap = document.createElement("div"); cap.id = "dCap"; document.body.appendChild(cap);
  const card = document.createElement("div"); card.id = "dCard"; document.body.appendChild(card);
  window.__demo = {
    move(x, y, fast) { c.classList.toggle("fast", !!fast); c.style.left = (x - 4) + "px"; c.style.top = (y - 2) + "px"; },
    ripple(x, y) { const r = document.createElement("div"); r.className = "dRipple"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 700); },
    cap(n, html) { cap.classList.remove("on"); setTimeout(() => { cap.innerHTML = (n ? '<span class="n">' + n + '</span>' : "") + '<span>' + html + '</span>'; cap.classList.add("on"); }, 250); },
    capOff() { cap.classList.remove("on"); },
    card(html) { card.innerHTML = html; card.classList.add("on"); },
    cardOff() { card.classList.remove("on"); },
  };
  return true;
})()`;
const overlay = () => js(OVERLAY);
await overlay();

// ---------- Acciones ----------
let cur = { x: 800, y: 450 };
async function rectOf(expr) {
  return js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
}
async function moveTo(expr, dx = 0, dy = 0) {
  const r = await rectOf(expr);
  if (!r) throw new Error("No encontré: " + expr);
  cur = { x: Math.round(r.x + dx), y: Math.round(r.y + dy) };
  await js(`__demo.move(${cur.x}, ${cur.y})`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cur.x, y: cur.y });
  await wait(800);
  return r;
}
async function click(expr, dx = 0, dy = 0) {
  await moveTo(expr, dx, dy);
  await js(`__demo.ripple(${cur.x}, ${cur.y})`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cur.x, y: cur.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cur.x, y: cur.y, button: "left", clickCount: 1 });
  await wait(500);
}
async function drag(expr, toY) {
  await moveTo(expr);
  const from = { ...cur };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(from.y + ((toY - from.y) * i) / steps);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y, button: "left", buttons: 1 });
    await js(`__demo.move(${from.x}, ${y}, true)`);
    await wait(35);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: toY, button: "left", clickCount: 1 });
  cur = { x: from.x, y: toY };
  await wait(600);
}
async function dblclick(expr) {
  await moveTo(expr);
  await js(`__demo.ripple(${cur.x}, ${cur.y})`);
  for (const clickCount of [1, 2]) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cur.x, y: cur.y, button: "left", clickCount });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cur.x, y: cur.y, button: "left", clickCount });
  }
  await wait(500);
}
const scrollTo = async (expr, block = "center") => { await js(`(${expr}).scrollIntoView({ behavior: "smooth", block: "${block}" }); true`); await wait(1300); };
const scrollTop = async () => { await js(`window.scrollTo({ top: 0, behavior: "smooth" }); true`); await wait(1000); };
const go = async (hash) => { await js(`__demo.capOff(); true`); await wait(300); await js(`location.hash = "${hash}"; true`); await wait(1800); await overlay(); };
const cap = async (n, text, ms) => { await js(`__demo.cap(${JSON.stringify(n)}, ${JSON.stringify(text)})`); if (ms) await wait(ms); };
const FIRST = `document.querySelector(".moments .moment")`;
const inFirst = (sel) => `${FIRST}.querySelector(${JSON.stringify(sel)})`;

// ---------- Guion ----------
await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
recording = true;

// Portada
await js(`__demo.card('<img src="/favicon.png"><h1><b>Keke</b>Clipper</h1><p>Cómo se usa, paso a paso</p><small>Clips graciosos de tus directos de Twitch, listos para Shorts, Reels y TikTok</small>')`);
await wait(4200);

// 1. Verificación
await go("#/setup");
await js(`__demo.cardOff()`);
await wait(600);
await cap(1, "Al abrir <b>KekeClipper</b>, revisa que esté todo instalado: FFmpeg, la IA local (Ollama) y los modelos de humor y de voz.", 3800);
await moveTo(`document.querySelector(".checks li:nth-child(5)")`, 120, 0);
await cap(1, "Si falta algo, aparece un botón <b>Instalar</b> y lo hace solo. Cuando está todo en verde, seguís.", 3600);
await click(`document.querySelector("#continue")`);
await wait(800);

// 2. Login (vista sin sesión, solo para mostrarla)
await js(`(() => { window.__realFetch = window.__realFetch || window.fetch; window.fetch = async (u, o) => { const r = await window.__realFetch(u, o); if (String(u).includes("/api/status")) { const j = await r.json(); j.user = null; return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } }); } return r; }; return true; })()`);
await go("#/inicio");
await cap(2, "Iniciá sesión con tu cuenta de <b>Twitch</b>. KekeClipper solo lee tu perfil para mostrarte tus directos.", 3400);
// (solo se muestra el clic: no se inicia un login real)
await moveTo(`document.querySelector(".login button")`);
await js(`__demo.ripple(${cur.x}, ${cur.y})`);
await wait(400);
await js(`(() => { const m = document.createElement("div"); m.className = "modal"; m.id = "demoModal"; m.innerHTML = '<div class="modal-box"><h2 style="margin-top:0">Conectar tu cuenta de Twitch</h2><p>1. Se abre twitch.tv/activate en tu navegador.</p><p>2. Si te lo pide, escribí este código:</p><div class="code">ABCD1234</div><p class="muted">Esperando que autorices en Twitch…</p></div>'; document.body.appendChild(m); return true; })()`);
await cap(2, "Se abre <b>twitch.tv/activate</b> en tu navegador con un código. Tocás <b>Autorizar</b> y listo: la app entra sola.", 4800);
await js(`document.getElementById("demoModal").remove(); window.fetch = window.__realFetch; true`);

// 3. Directos
await go("#/");
await wait(1500);
await cap(3, "Ves todos tus <b>directos (VODs)</b>. Elegí el que quieras analizar.", 3000);
await moveTo(`[...document.querySelectorAll(".vod")].find(v => v.querySelector(".badge"))`, 0, -40);
await wait(1200);
await click(`[...document.querySelectorAll(".vod")].find(v => v.querySelector(".badge")).querySelector("button")`);
await wait(2200);
await overlay();

// 4. Análisis
await scrollTop();
await moveTo(`document.querySelector("#maxClips")`);
await cap(4, "Elegí <b>cuántos clips</b> querés (o automático según la calidad) y tocá <b>Analizar</b>.", 3600);
await moveTo(`document.querySelector("#analyze")`);
await cap(4, "La app escucha el directo entero <b>sin descargarlo</b>: lee el chat, detecta las risas y la IA entiende el humor latino.", 4600);

// 5. Línea de tiempo
await scrollTo(`document.querySelector("#tl")`);
await moveTo(`document.querySelector("#tl")`, 120, 10);
await cap(5, "La <b>línea de tiempo</b> muestra dónde hubo más risas. Los puntos blancos son los clips elegidos.", 4200);

// 6. Boceto
await scrollTo(FIRST, "start");
await js(`window.scrollBy({ top: -70, behavior: "smooth" }); true`);
await wait(900);
await moveTo(inFirst(".score"));
await cap(6, "Cada momento trae un <b>puntaje</b>, el tipo de humor y un título. Tildá <b>incluir</b> en los que te gusten.", 3800);
await moveTo(inFirst(".sel"));
await wait(900);
await click(inFirst(".load-preview"));
await cap(6, "Con <b>Ver boceto</b> lo ves en formato teléfono 9:16, como va a quedar el Short.", 4200);
await moveTo(inFirst(".nudge button[data-n='end:1']"));
await cap(6, "Ajustá dónde <b>empieza y termina</b> el clip con los botones −5s / +5s.", 3400);

// 7. Título y subtítulos
await moveTo(inFirst(".f-hookOn"));
await cap(7, "Podés <b>poner o sacar el título</b> del video, cambiar el texto y cuánto tiempo se ve.", 3800);
await moveTo(inFirst(".f-subsOn"));
await cap(7, "Lo mismo con los <b>subtítulos</b>: prendelos o apagalos, y elegí tamaño y color.", 3400);
await click(inFirst(".act-subs"));
await wait(1500);
await scrollTo(inFirst(".subs-editor"));
await moveTo(inFirst(".subs-list .s-t"));
await cap(7, "En <b>Editar subtítulos</b> corregís cada línea, sus tiempos, o agregás y borrás líneas.", 4600);
await click(inFirst(".act-subs"));
await wait(600);
await scrollTo(inFirst(".phone"));
await cap(8, "<b>Arrastrá</b> el título o los subtítulos en el boceto para ubicarlos donde quieras.", 600);
const sub = await rectOf(inFirst(".sub"));
await drag(inFirst(".sub"), Math.round(sub.y - 150));
await wait(800);
await cap(8, "Doble clic los devuelve a su lugar original.", 700);
await dblclick(inFirst(".sub"));
await wait(1800);

// 9. Generar y subir
await scrollTo(inFirst(".act-render"));
await moveTo(inFirst(".act-render"));
await cap(9, "<b>Generar short</b> baja solo ese tramo y lo guarda en tu PC en 1080×1920, junto a un texto con títulos y hashtags.", 4600);
await scrollTo(inFirst(".result .upload"));
await moveTo(inFirst(".act-yt"));
await cap(9, "Con un clic copia el texto, te muestra el archivo y abre la página para subirlo a <b>YouTube</b>…", 2600);
await moveTo(inFirst(".act-ig"));
await wait(900);
await moveTo(inFirst(".act-tt"));
await cap(9, "…a <b>Instagram</b> o a <b>TikTok</b>. Con <b>Generar todos los seleccionados</b> hacés todos de una.", 3600);

// 10. Resumen
await scrollTo(`document.querySelector("#summaryBox")`, "start");
await js(`window.scrollBy({ top: -80, behavior: "smooth" }); true`);
await wait(900);
await moveTo(`document.querySelector("#summary")`);
await cap(10, "<b>Resumen para YouTube</b>: hasta 10 minutos con los mejores momentos, en orden, con cortes limpios y capítulos.", 5000);
await moveTo(`document.querySelector("#sCopy")`);
await cap(10, "Te deja listos el título, la descripción con capítulos y los tags para pegar en YouTube.", 3800);

// 11. Hashtags y configuración
await go("#/hashtags");
await moveTo(`document.querySelector(".combo")`);
await cap(11, "En <b>Hashtags</b> tenés las tendencias de Overwatch y del streaming latino. Clic para copiar.", 4200);
await go("#/config");
await moveTo(`document.querySelector("#defaultLayout")`);
await cap(12, "En <b>Configuración</b> elegís la IA, la carpeta de clips, el formato y dónde está tu facecam.", 4400);
await js(`__demo.capOff()`);
await wait(400);

// Cierre
await go("#/");
await js(`__demo.card('<img src="/favicon.png"><h1><b>Keke</b>Clipper</h1><p>¡Listo para clipear tus mejores momentos!</p><small>creado por: <b>krkmauri</b></small><span class="tw">twitch.tv/krkmauri</span>')`);
await wait(4500);

const stopAt = Date.now() / 1000;
recording = false;
await send("Page.stopScreencast");
await js(`__demo.cardOff(); document.getElementById("dCursor")?.remove(); true`);

// Lista para ffmpeg (cada cuadro dura hasta el siguiente)
const lines = [];
frames.forEach((fr, i) => {
  const next = frames[i + 1]?.t ?? Math.max(fr.t + 0.5, stopAt); // la pantalla quieta no genera cuadros: el último dura hasta el final
  lines.push(`file '${path.basename(fr.f)}'`, `duration ${Math.max(0.001, next - fr.t).toFixed(3)}`);
});
lines.push(`file '${path.basename(frames.at(-1).f)}'`);
fs.writeFileSync(path.join(OUT, "frames.txt"), lines.join("\n"));
console.log(`OK: ${frames.length} cuadros, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);
ws.close();
