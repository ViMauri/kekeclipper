// UI de KekeClipper (sin frameworks)
import { normalizeFrame, fitRect, fullRect, zoneAspect, SRC_AR } from "/framing.js";
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
let status = null;
const watched = new Map(); // jobId -> callback al terminar

const UPLOAD = {
  yt: "https://www.youtube.com/upload",
  ig: "https://www.instagram.com/",
  tt: "https://www.tiktok.com/tiktokstudio/upload",
};

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function fmt(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function parseT(v) { const p = String(v).trim().split(":").map(Number); return p.reduce((a, b) => a * 60 + b, 0); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Copiado ✅"); } catch { prompt("Copiá el texto:", text); } }

// ---------- Jobs ----------
async function pollJobs() {
  try {
    const jobs = await api("/api/jobs");
    const box = $("#jobs");
    const visible = jobs.filter((j) => j.status === "running" || (Date.now() - j.startedAt < 15000 && j.status !== "done") || j.status === "error" && Date.now() - j.startedAt < 600000);
    box.innerHTML = visible.map((j) => `<div class="job ${j.status}"><button class="x" data-cancel="${j.id}">${j.status === "running" ? "cancelar" : "✕"}</button><b>${({ analyze: "Analizando", render: "Short", "render-batch": "Shorts", summary: "Resumen", hashtags: "Hashtags", subs: "Subtítulos", setup: "Instalando" })[j.type] || j.type}</b> · ${esc(j.message)}<div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div></div>`).join("");
    for (const j of jobs) {
      const cb = watched.get(j.id);
      if (cb && j.status !== "running") { watched.delete(j.id); cb(j); }
    }
  } catch {}
  setTimeout(pollJobs, 1500);
}
$("#jobs").addEventListener("click", async (e) => {
  const id = e.target.dataset.cancel;
  if (id) { await api(`/api/jobs/${id}/cancel`, { method: "POST" }); e.target.closest(".job").remove(); }
});
function watch(job, cb) { watched.set(job.id, cb); }

// ---------- Router ----------
let setupDone = (() => { try { return sessionStorage.getItem("setupOk") === "1"; } catch { return false; } })();
async function route() {
  status = await api("/api/status");
  view.onclick = null;
  renderWho();
  const h = location.hash.replace(/^#\/?/, "");
  // 1) Al abrir la app: verificar complementos. 2) Pedir login con Twitch. 3) Recién ahí, el menú.
  if (!setupDone || h === "setup") return viewSetup();
  if (!status.user && h !== "config") return viewLogin();
  document.body.classList.remove("bare");
  if (h.startsWith("stream/")) return viewStream(h.split("/")[1]);
  if (h === "hashtags") return viewHashtags();
  if (h === "config") return viewConfig();
  return viewHome();
}
window.addEventListener("hashchange", route);

function renderWho() {
  const u = status.user;
  $("#who").innerHTML = u
    ? `<img src="${esc(u.profile_image_url)}" alt=""> ${esc(u.display_name)} <button id="logout">Salir</button>`
    : status.twitchLogin === "oauth" ? `<a href="/auth/twitch/login"><button class="primary">Conectar Twitch</button></a>`
    : status.twitchLogin === "device" ? `<button class="primary" id="connect">Conectar Twitch</button>`
    : `<a href="#/config">Conectar Twitch</a>`;
  $("#logout")?.addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); route(); });
  $("#connect")?.addEventListener("click", deviceLogin);
}

// Login por código: el usuario lo confirma en twitch.tv/activate con SU cuenta
async function deviceLogin() {
  let d;
  try { d = await api("/api/twitch/device/start", { method: "POST" }); } catch (e) { return toast(e.message); }
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-box">
    <h2 style="margin-top:0">Conectar tu cuenta de Twitch</h2>
    <p>1. Abrí la página de Twitch (ya lleva el código):</p>
    <p><a class="btn-link" href="${esc(d.verification_uri)}" target="_blank" rel="noopener"><button class="primary">Abrir twitch.tv/activate</button></a></p>
    <p>2. Si te lo pide, escribí este código:</p>
    <div class="code">${esc(d.user_code)}</div>
    <p class="muted" id="dstat">Esperando que autorices en Twitch…</p>
    <button id="dcancel">Cancelar</button></div>`;
  document.body.appendChild(modal);
  let alive = true;
  $("#dcancel", modal).onclick = () => { alive = false; modal.remove(); };
  window.open(d.verification_uri, "_blank");
  while (alive) {
    await new Promise((r) => setTimeout(r, (d.interval || 5) * 1000));
    if (!alive) break;
    const p = await api("/api/twitch/device/poll", { method: "POST" }).catch(() => ({ status: "pending" }));
    if (p.status === "ok") { modal.remove(); toast(`¡Conectado como ${p.user?.display_name || "vos"}! ✅`); route(); break; }
    if (p.status === "denied" || p.status === "expired") { $("#dstat", modal).textContent = p.status === "denied" ? "Cancelaste la autorización en Twitch." : "El código venció. Cerrá y probá de nuevo."; break; }
  }
}

// ---------- Verificación de complementos (al abrir la app) ----------
async function viewSetup() {
  document.body.classList.add("bare");
  const auto = !setupDone;
  view.innerHTML = `<div class="center-screen"><div class="card setup">
    <div class="logo-big"><img class="logo-img" src="/favicon.png" alt=""><b>Keke</b>Clipper</div>
    <h2>Verificando que esté todo instalado…</h2>
    <ul class="checks" id="checks"><li class="muted">Revisando…</li></ul>
    <div class="row" id="setupActions"></div></div></div>`;
  let busy = false;
  const draw = async () => {
    const r = await api("/api/setup");
    const h2 = view.querySelector(".setup h2"); if (h2) h2.textContent = r.ready ? "Todo listo ✅" : "Faltan algunas cosas para empezar";
    const jobs = await api("/api/jobs");
    const runningFor = (a) => jobs.find((j) => j.type === "setup" && j.meta?.action === a && j.status === "running");
    $("#checks").innerHTML = r.items.map((i) => {
      const j = i.action && runningFor(i.action);
      return `<li class="${i.ok ? "ok" : i.required ? "bad" : "opt"}">
        <span class="ic">${i.ok ? "✅" : j ? "⏳" : i.required ? "❌" : "⚪"}</span>
        <span class="nm">${esc(i.name)}<small>${esc(j ? j.message : i.detail)}</small>${j ? `<span class="minibar"><i style="width:${Math.round(j.progress * 100)}%"></i></span>` : ""}</span>
        ${i.action && !j ? `<button class="primary" data-act="${i.action}">${i.action.startsWith("install") ? "Instalar" : i.action === "start-ollama" ? "Encender" : "Descargar"}</button>` : ""}
      </li>`;
    }).join("");
    const missing = r.items.filter((i) => !i.ok && i.action);
    const anyRunning = jobs.some((j) => j.type === "setup" && j.status === "running");
    $("#setupActions").innerHTML = `
      ${missing.length > 1 && !anyRunning ? `<button class="primary" id="allMissing">Instalar todo lo que falta</button>` : ""}
      ${!r.wingetAvailable && missing.some((i) => i.action.startsWith("install")) ? `<p class="muted">No encontré <b>winget</b>: instalá "App Installer" desde la Microsoft Store.</p>` : ""}
      ${r.items.find((i) => i.id === "twitch" && !i.ok) ? `<p class="muted">Falta el ID público de Twitch en la app (lo agrega quien la distribuye) o cargá el tuyo en <a href="#/config" id="toCfg">Configuración</a>.</p>` : ""}
      <span style="flex:1"></span>
      <button id="recheck">Volver a verificar</button>
      <button class="${r.ready ? "primary" : ""}" id="continue" ${r.ready ? "" : "disabled"}>Continuar →</button>`;
    const go = () => { setupDone = true; try { sessionStorage.setItem("setupOk", "1"); } catch {} if (location.hash === "#/setup") location.hash = "#/"; else route(); };
    $("#continue").onclick = go;
    $("#recheck").onclick = draw;
    $("#toCfg") && ($("#toCfg").onclick = () => { setupDone = true; });
    const run = async (a) => { const job = await api(`/api/setup/${a}`, { method: "POST" }); watch(job, (j) => { if (j.status === "error") toast(j.error); draw(); }); draw(); };
    $("#checks").onclick = (e) => { const a = e.target.dataset.act; if (a) run(a); };
    if ($("#allMissing")) $("#allMissing").onclick = async () => { for (const i of missing) { const job = await api(`/api/setup/${i.action}`, { method: "POST" }); await new Promise((res) => watch(job, res)); } draw(); };
    if (anyRunning && !busy) { busy = true; setTimeout(() => { busy = false; if (location.hash === "#/setup" || !setupDone) draw(); }, 1500); }
    if (r.ready && auto && !anyRunning) setTimeout(() => { if (!setupDone) go(); }, 1200);
  };
  await draw();
}

// ---------- Login con Twitch (obligatorio) ----------
function viewLogin() {
  document.body.classList.add("bare");
  const params = new URLSearchParams(location.search);
  const err = params.get("twitch_error");
  view.innerHTML = `<div class="center-screen"><div class="card login">
    <div class="logo-big"><img class="logo-img" src="/favicon.png" alt=""><b>Keke</b>Clipper</div>
    <p>Encuentra los momentos más graciosos de tus directos y los convierte en Shorts.</p>
    ${err ? `<div class="banner bad">Twitch: ${esc(err)}</div>` : ""}
    ${status.twitchLogin === "oauth" ? `<a href="/auth/twitch/login"><button class="primary big twitch">Iniciar sesión con Twitch</button></a>`
      : status.twitchLogin === "device" ? `<button class="primary big twitch" id="loginBtn">Iniciar sesión con Twitch</button>`
      : `<div class="banner bad">Falta el ID público de Twitch. Cargalo en <a href="#/config">Configuración</a>.</div>`}
    <p class="muted small">Solo pedimos leer tu perfil para mostrarte tus VODs. Nada se publica en tu nombre.</p>
  </div></div>`;
  $("#loginBtn")?.addEventListener("click", deviceLogin);
}

// ---------- Inicio: lista de directos ----------
async function viewHome() {
  const warn = [];
  if (!status.ffmpeg) warn.push(`<div class="banner bad">⚠️ No encontré <b>ffmpeg</b>. Instalalo con <code>winget install Gyan.FFmpeg</code> y reiniciá la app.</div>`);
  if (!status.ai) warn.push(`<div class="banner">🤖 No hay IA activa: el análisis usa solo señales de chat/audio y no "entiende" los chistes. Activá la <b>IA local gratis</b> o Claude en <a href="#/config">Configuración</a>.</div>`);
  else if (status.aiProvider === "ollama") warn.push(`<div class="banner">🧠 Usando IA local gratis (${esc(status.config.ollamaModel)}). Es más lenta que Claude: el análisis puede tardar un rato.</div>`);
  const err = new URLSearchParams(location.search).get("twitch_error");
  if (err) warn.push(`<div class="banner bad">Twitch: ${esc(err)}</div>`);
  view.innerHTML = `${warn.join("")}
    <div class="row home-head"><h1>Tus directos</h1><span class="muted">Elegí un VOD para analizarlo.</span><span style="flex:1"></span><button id="reloadVods">↻ Actualizar</button></div>
    <details class="card other"><summary>Ver otro canal o pegar el link de un VOD</summary>
      <div class="row" style="margin-top:10px">
        <input id="ch" placeholder="Canal de Twitch" value="${esc(status.user?.login || status.config.channel || "")}" style="max-width:300px">
        <button class="primary" id="load">Cargar VODs</button>
        <span class="muted">o</span>
        <input id="vodurl" placeholder="https://www.twitch.tv/videos/123…" style="max-width:300px">
        <button id="go">Abrir</button>
      </div>
    </details>
    <div id="vods" class="vods"></div>`;
  function parseTwitch(raw) {
    const s = String(raw || "").trim();
    let m = /(?:videos\/|\/v\/|[?&]video=v?)(\d{5,})/i.exec(s) || /^v?(\d{6,})$/i.exec(s);
    if (m) return { vod: m[1] };
    m = /twitch\.tv\/(?:popout\/)?@?([a-z0-9_]{2,25})/i.exec(s);
    if (m && !/^(videos|directory|settings|search|p|downloads|subscriptions|inventory|wallet|drops)$/i.test(m[1])) return { channel: m[1].toLowerCase() };
    m = /^@?([a-z0-9_]{2,25})$/i.exec(s);
    if (m) return { channel: m[1].toLowerCase() };
    return {};
  }
  const load = async () => {
    const box = $("#vods");
    box.innerHTML = `<p class="muted">Cargando…</p>`;
    try {
      const vods = await api("/api/vods?channel=" + encodeURIComponent($("#ch").value));
      if (!vods.length) { box.innerHTML = `<p class="muted">No hay VODs guardadas en ese canal.</p>`; return; }
      box.innerHTML = vods.map((v) => `<div class="vod">
        <img loading="lazy" src="${esc(v.thumbnail || "")}" onerror="this.style.visibility='hidden'">
        <div class="b"><div class="t">${esc(v.title)}</div>
        <div class="m">${new Date(v.createdAt).toLocaleString()} · ${fmt(v.duration)} ${v.game ? "· " + esc(v.game) : ""}</div>
        ${v.analyzed ? `<span class="badge">ya analizado</span>` : ""}
        <div class="row" style="margin-top:auto"><a href="#/stream/${v.id}"><button class="primary">${v.analyzed ? "Ver clips" : "Analizar"}</button></a></div></div></div>`).join("");
    } catch (e) { box.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  };
  $("#load").onclick = load;
  // Cualquiera de los dos campos acepta: nombre, @nombre, link del canal, link de "videos" del canal o link de un VOD
  const smart = (text, fallback) => {
    const t = parseTwitch(text);
    if (t.vod) { location.hash = `#/stream/${t.vod}`; return; }
    if (t.channel) { $("#ch").value = t.channel; load(); return; }
    toast(fallback);
  };
  $("#load").onclick = () => smart($("#ch").value, "No reconozco ese canal");
  $("#go").onclick = () => smart($("#vodurl").value, "No reconozco ese link: pegá el de un video (twitch.tv/videos/…) o el del canal");
  $("#ch").onkeydown = (e) => { if (e.key === "Enter") $("#load").click(); };
  $("#vodurl").onkeydown = (e) => { if (e.key === "Enter") $("#go").click(); };
  $("#reloadVods").onclick = () => { $("#ch").value = status.user?.login || $("#ch").value; load(); };
  if ($("#ch").value) load();
}

// ---------- Vista de un directo ----------
async function viewStream(vodId) {
  view.innerHTML = `<p class="muted">Cargando…</p>`;
  const a = await api(`/api/streams/${vodId}`);
  const running = (await api("/api/jobs")).find((j) => j.type === "analyze" && j.meta?.vodId === vodId && j.status === "running");
  const m = a.meta;
  view.innerHTML = `
    <a href="#/">← Directos</a>
    <h1>${esc(m?.title || "VOD " + vodId)}</h1>
    <div class="card">
      <div class="analyze-opts">
        <label>Cantidad de clips
          <select id="maxClips"><option value="auto">Automático (según calidad)</option>${[3, 5, 8, 10, 15, 20, 30].map((n) => `<option>${n}</option>`).join("")}</select></label>
        <label><input type="checkbox" id="deep" style="width:auto"> Análisis profundo (transcribe TODO el directo — tarda bastante más, encuentra chistes aunque el chat no reaccione)</label>
        <button class="primary" id="analyze" ${running ? "disabled" : ""}>${a.moments.length ? "Re-analizar" : "🔍 Analizar directo completo"}</button>
      </div>
      <p class="muted" style="margin:10px 0 0">Nada se descarga: el chat se lee como texto y el audio/video se escucha por streaming desde Twitch. Solo se guardan en tu PC los clips que generes.</p>
    </div>
    <div id="body"></div>`;
  $("#analyze").onclick = async () => {
    $("#analyze").disabled = true;
    const job = await api("/api/analyze", { method: "POST", body: { vodId, maxClips: $("#maxClips").value, deep: $("#deep").checked, reuse: true } });
    watch(job, (j) => { if (j.status === "done") toast("¡Análisis listo!"); route(); });
  };
  if (running) watch(running, () => route());
  if (!a.moments.length) { $("#body").innerHTML = running ? `<p class="muted">Analizando… podés dejar esta pestaña abierta, tarda (la app escucha el directo entero).</p>` : ""; return; }
  renderStreamBody(vodId, a);
}

function renderStreamBody(vodId, a) {
  const moments = a.moments.sort((x, y) => (y.selected - x.selected) || (y.score - x.score));
  const sel = moments.filter((x) => x.selected).length;
  $("#body").innerHTML = `
    <h2>Línea de tiempo de risas</h2>
    <canvas class="timeline" id="tl"></canvas>
    <p class="muted" style="font-size:12px">Rojo: risa combinada (chat + audio). Gris: mensajes por minuto. Puntos: momentos (blanco = seleccionado). Clic para ir al momento.</p>
    <div class="card row">
      <b>${sel} clips seleccionados</b> de ${moments.length} momentos analizados
      <button class="primary" id="renderSel">⚙️ Generar todos los seleccionados</button>
      <button id="openFolder">📂 Abrir carpeta de clips</button>
      <span style="flex:1"></span>
      <button class="warn" id="summary">📺 Resumen para YouTube</button>
    </div>
    <div id="summaryBox"></div>
    <h2>Bocetos de clips</h2>
    <div class="moments" id="moments"></div>`;
  drawTimeline(a, moments);
  const box = $("#moments");
  for (const m of moments) box.appendChild(momentCard(vodId, m));
  $("#renderSel").onclick = async () => {
    const job = await api(`/api/streams/${vodId}/render-selected`, { method: "POST" });
    toast("Generando shorts seleccionados…");
    watch(job, () => { toast("Shorts listos en tu carpeta ✅"); route(); });
  };
  $("#openFolder").onclick = () => api("/api/reveal", { method: "POST", body: {} });
  $("#summary").onclick = async () => {
    const job = await api(`/api/streams/${vodId}/summary`, { method: "POST", body: { render: true } });
    toast("Armando el resumen del directo…");
    watch(job, () => route());
  };
  if (a.summary) renderSummary(a.summary);
}

function renderSummary(s) {
  $("#summaryBox").innerHTML = `<div class="card summary-box">
    <h2 style="margin-top:0">📺 Resumen para YouTube</h2>
    <label>Título <input value="${esc(s.titulo)}" readonly></label>
    <p class="muted">${s.duration ? `⏱️ Duración: <b>${fmt(s.duration)}</b> · ${(s.segments || []).length} tramos en orden cronológico · ` : ""}${esc(s.resumen || "")}</p>
    <pre>${esc(s.description)}</pre>
    <p class="muted">Texto para la miniatura: <b>${esc(s.miniatura_texto || "")}</b> · Tags: ${esc((s.tags || []).join(", "))}</p>
    ${s.url ? `<video controls src="${s.url}" style="width:100%;max-width:640px;border-radius:10px"></video>` : `<p class="muted">El video del resumen se está generando o no se generó todavía.</p>`}
    <div class="row">
      <button id="sCopy">📋 Copiar título + descripción</button>
      ${s.file ? `<button class="primary" id="sYt">▶️ Subir a YouTube</button><button id="sFolder">📂 Ver archivo</button>` : ""}
    </div></div>`;
  $("#sCopy").onclick = () => copy(`${s.titulo}\n\n${s.description}`);
  if (s.file) {
    $("#sYt").onclick = async () => { await copy(`${s.titulo}\n\n${s.description}`); await api("/api/reveal", { method: "POST", body: { path: s.file } }); window.open(UPLOAD.yt, "_blank"); };
    $("#sFolder").onclick = () => api("/api/reveal", { method: "POST", body: { path: s.file } });
  }
}

function drawTimeline(a, moments) {
  const cv = $("#tl"); if (!cv || !a.curve) return;
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const { curve, chatRate, bin } = a.curve;
  const dur = curve.length * bin;
  const maxC = Math.max(...curve, 1), maxR = Math.max(...(chatRate || [1]), 1);
  g.strokeStyle = "#555"; g.beginPath();
  (chatRate || []).forEach((v, i) => { const x = (i / curve.length) * W, y = H - 6 - (v / maxR) * (H - 20) * 0.6; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  g.strokeStyle = "#e10600"; g.lineWidth = 1.5; g.beginPath();
  curve.forEach((v, i) => { const x = (i / curve.length) * W, y = H - 6 - (v / maxC) * (H - 20); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  g.fillStyle = "#888"; g.font = "11px system-ui";
  for (let t = 0; t < dur; t += 1800) g.fillText(fmt(t).slice(0, -3), (t / dur) * W + 2, 12);
  for (const m of moments) {
    const x = (m.peak / dur) * W;
    g.fillStyle = m.selected ? "#ffffff" : "#6c6c80";
    g.beginPath(); g.arc(x, 22, m.selected ? 5 : 3.5, 0, 7); g.fill();
  }
  cv.onclick = (e) => {
    const t = (e.offsetX / W) * dur;
    const near = moments.reduce((b, m) => (Math.abs(m.peak - t) < Math.abs(b.peak - t) ? m : b), moments[0]);
    const el = document.getElementById("m-" + near.id);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1300); }
  };
}

// ---------- Tarjeta de momento con boceto ----------
function momentCard(vodId, m) {
  const el = $("#tpl-moment").content.firstElementChild.cloneNode(true);
  el.id = "m-" + m.id;
  const phone = $(".phone", el);
  const set = (cls, v) => { $(cls, el).value = v; };
  set(".f-titulo", m.titulo || ""); set(".f-gancho", m.gancho || ""); set(".f-descripcion", m.descripcion || "");
  set(".f-start", fmt(m.start)); set(".f-end", fmt(m.end)); set(".f-layout", m.layout || "blur");
  $(".f-selected", el).checked = m.selected;
  el.classList.toggle("is-selected", m.selected);
  const sc = $(".score", el); sc.textContent = m.score.toFixed(1); sc.classList.toggle("hot", m.score >= 8);
  $(".tipo", el).textContent = (m.tipo || "") + (m.aiJudged ? "" : " · sin IA");
  $(".when", el).textContent = `@ ${fmt(m.peak)}`;
  $(".porque", el).textContent = m.por_que || "";
  $(".transcript", el).textContent = m.transcript || "(sin transcripción)";
  $(".tags", el).innerHTML = (m.hashtagsFinal || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  $(".tags", el).onclick = (e) => { if (e.target.classList.contains("chip")) copy(e.target.textContent); };

  // ----- Título y subtítulos (opcionales, editables, se arrastran en el boceto) -----
  // Encuadre del clip (cámara, juego, zoom). Mismo cálculo que el render: src/framing.js
  let fr = normalizeFrame(m.frame, { facecam: status.config.facecam, cropX: m.cropX ?? 0.5 });
  const defaultSubY = (layout) => (layout === "facecam" ? fr.camH + 460 : layout === "crop" ? 1350 : 1480);
  const tx = { subY: m.subY ?? null, hookY: m.hookY ?? 250, subs: m.subs || null };
  $(".f-hookOn", el).checked = m.hookOn !== false;
  $(".f-hookDur", el).value = String(m.hookDur ?? 4);
  $(".f-subsOn", el).checked = m.subsOn !== false;
  $(".f-subScale", el).value = m.subScale ?? 100;
  $(".f-subStyle", el).value = m.subStyle || "";
  const firstLine = (m.transcript || "").split("\n").map((l) => l.replace(/^\[[^\]]+\]\s*/, "")).find((l) => l.length > 3) || "";
  const previewSubText = () => {
    const s0 = parseT($(".f-start", el).value);
    const line = tx.subs?.find((s) => s.end > s0)?.text || firstLine;
    const words = line.replace(/(\p{L})\1{3,}/gu, "$1$1$1$1$1").split(/\s+/).filter(Boolean);
    return m.subsEdited ? words.join(" ") : words.slice(0, 3).join(" ");
  };
  const updatePreview = () => {
    const hook = $(".hook", el), sub = $(".sub", el);
    hook.textContent = $(".f-gancho", el).value.replace(/\p{Extended_Pictographic}|️|‍/gu, "").trim(); // el video no lleva emojis
    hook.classList.toggle("off", !$(".f-hookOn", el).checked);
    hook.style.top = tx.hookY / 5 + "px";
    sub.textContent = previewSubText();
    sub.classList.toggle("off", !$(".f-subsOn", el).checked);
    sub.style.top = (tx.subY ?? defaultSubY($(".f-layout", el).value)) / 5 + "px";
    sub.style.fontSize = 17 * (+$(".f-subScale", el).value || 100) / 100 + "px";
    const col = $(".f-subStyle", el).value || status.config.subtitleStyle;
    sub.classList.toggle("white", col === "blanco"); sub.classList.toggle("green", col === "verde");
    $(".f-gancho", el).disabled = !$(".f-hookOn", el).checked;
    $(".f-hookDur", el).disabled = !$(".f-hookOn", el).checked;
    const s = parseT($(".f-start", el).value), e = parseT($(".f-end", el).value);
    $(".dur", el).textContent = `${Math.max(0, e - s)} s`;
    phone.dataset.layout = $(".f-layout", el).value;
    layoutStage();
    drawFramer();
  };

  // Boceto: cada zona del 9:16 muestra su recorte del video (reproductor de Twitch en vivo,
  // o el fotograma del editor de encuadre si todavía no tocaste "Ver boceto").
  let picUrl = null;
  const layoutStage = () => {
    const stage = $(".stage", el);
    const layout = $(".f-layout", el).value;
    const live = !!stage.dataset.loaded;
    if (!live && !picUrl) { stage.innerHTML = ""; stage.dataset.key = ""; return; }
    const t = parseT($(".f-start", el).value);
    const src = live ? `https://player.twitch.tv/?video=v${vodId}&parent=${location.hostname}&time=${Math.floor(t / 3600)}h${Math.floor(t / 60) % 60}m${t % 60}s&autoplay=false` : picUrl;
    const W = 216, H = 384; // pantalla del boceto (1 px = 5 px del video)
    let wins; // [arriba, alto, rectángulo del original]
    if (layout === "crop") wins = [[0, H, fr.crop]];
    else if (layout === "facecam") { const ch = fr.camH / 5; wins = [[0, ch, fr.cam], [ch, H - ch, fr.game]]; }
    else { const h = W / SRC_AR; wins = [[(H - h) / 2 - 16, h, fr.fg]]; }
    const key = layout + "|" + src;
    if (stage.dataset.key !== key) { // solo se recrea si cambia el formato o la fuente (no recarga el reproductor al arrastrar)
      stage.dataset.key = key;
      stage.innerHTML = wins.map(() => `<div class="win">${live ? `<iframe src="${esc(src)}" allowfullscreen></iframe>` : `<img class="src" src="${esc(src)}" alt="">`}</div>`).join("");
    }
    [...stage.children].forEach((w, i) => {
      const [top, h, r] = wins[i], fw = W / r.w, fh = fw / SRC_AR;
      Object.assign(w.style, { left: "0px", top: top + "px", width: W + "px", height: h + "px" });
      Object.assign(w.firstElementChild.style, { width: fw + "px", height: fh + "px", left: -r.x * fw + "px", top: -r.y * fh + "px" });
    });
  };

  // ----- Editor de encuadre: rectángulos sobre un fotograma real del clip -----
  const ZONES = { crop: [["crop", "Pantalla"]], facecam: [["game", "Juego"], ["cam", "Cámara"]], blur: [["fg", "Video"]] };
  const HELP = {
    crop: "El recuadro blanco es lo que se ve en el Short. Arrastralo para moverlo; desde la esquina lo agrandás (alejar) o achicás (zoom).",
    facecam: "Rojo = tu cámara (va arriba). Blanco = el juego (va abajo). Arrastrá cada recuadro y cambiá su tamaño desde la esquina. Flechas del teclado = ajuste fino.",
    blur: "El recuadro es lo que se ve en el centro, sobre el fondo desenfocado. Achicalo para hacer zoom y movelo para encuadrar.",
  };
  const framer = $(".framer", el), pic = $(".framer-pic", el), img = $("img", pic);
  let selZone = null, picIdx = 0;
  const layoutNow = () => $(".f-layout", el).value;
  const zonesNow = () => ZONES[layoutNow()] || ZONES.blur;
  const aspectOf = (z) => zoneAspect(z, fr.camH);
  const drawFramer = () => {
    if (framer.classList.contains("hidden")) return;
    const zs = zonesNow();
    if (!zs.some(([z]) => z === selZone)) selZone = zs[0][0];
    $(".framer-help", el).textContent = HELP[layoutNow()] || HELP.blur;
    $(".fsel-name", el).textContent = zs.find(([z]) => z === selZone)[1];
    framer.querySelectorAll(".camh").forEach((n) => n.classList.toggle("hidden", layoutNow() !== "facecam"));
    $(".f-camH", el).value = fr.camH;
    let boxes = [...pic.querySelectorAll(".fz")];
    if (boxes.map((b) => b.dataset.z).join() !== zs.map(([z]) => z).join()) {
      boxes.forEach((b) => b.remove());
      boxes = zs.map(([z, name]) => {
        const d = document.createElement("div");
        d.className = "fz" + (z === "cam" ? " cam" : ""); d.dataset.z = z;
        d.innerHTML = `<span class="lbl">${name}</span><span class="h" title="Arrastrá para cambiar el tamaño"></span>`;
        pic.appendChild(d); return d;
      });
    }
    for (const b of boxes) {
      const r = fr[b.dataset.z];
      Object.assign(b.style, { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%" });
      b.classList.toggle("sel", b.dataset.z === selZone);
    }
  };
  const frameChanged = () => { drawFramer(); updatePreview(); save(); };
  const loadPic = () => {
    const s0 = parseT($(".f-start", el).value), e0 = parseT($(".f-end", el).value);
    const ts = [s0 + Math.min(3, (e0 - s0) / 4), (s0 + e0) / 2, Math.max(s0, e0 - 3)];
    const ld = $(".framer-loading", el);
    ld.textContent = "Sacando un fotograma del clip…"; ld.classList.remove("hidden"); img.style.visibility = "hidden";
    img.onload = () => { ld.classList.add("hidden"); img.style.visibility = ""; picUrl = img.src; layoutStage(); };
    img.onerror = () => { ld.textContent = "No pude sacar el fotograma (¿ffmpeg instalado? ¿el VOD sigue en Twitch?)."; };
    img.src = `/api/streams/${vodId}/frame?t=${Math.round(ts[picIdx % ts.length])}`;
  };
  $(".act-frame", el).onclick = () => {
    framer.classList.toggle("hidden");
    if (framer.classList.contains("hidden")) return;
    if (!img.getAttribute("src")) loadPic();
    drawFramer(); framer.focus({ preventScroll: true });
  };
  pic.addEventListener("pointerdown", (ev) => {
    const box = ev.target.closest(".fz"); if (!box) return;
    ev.preventDefault();
    const z = box.dataset.z; selZone = z; drawFramer();
    const b = pic.getBoundingClientRect(), start = { ...fr[z] };
    const p0 = [(ev.clientX - b.left) / b.width, (ev.clientY - b.top) / b.height];
    const resizing = ev.target.classList.contains("h");
    pic.setPointerCapture(ev.pointerId);
    const move = (e) => {
      const p = [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
      if (resizing) {
        const k = aspectOf(z) / SRC_AR; // ancho = alto * k (en fracciones del original)
        const h = Math.max(0.05, p[1] - start.y, (p[0] - start.x) / k);
        fr[z] = fitRect({ x: start.x, y: start.y, w: h * k, h }, aspectOf(z), "topleft");
      } else {
        fr[z] = fitRect({ ...start, x: start.x + p[0] - p0[0], y: start.y + p[1] - p0[1] }, aspectOf(z), "topleft");
      }
      drawFramer(); updatePreview();
    };
    const up = () => { pic.removeEventListener("pointermove", move); pic.removeEventListener("pointerup", up); save(); };
    pic.addEventListener("pointermove", move); pic.addEventListener("pointerup", up);
  });
  framer.addEventListener("click", async (ev) => {
    const f = ev.target.closest("[data-f]")?.dataset.f; if (!f) return;
    const z = selZone, r = fr[z], asp = aspectOf(z);
    if (f === "cx") fr[z] = { ...r, x: +((1 - r.w) / 2).toFixed(4) };
    else if (f === "cy") fr[z] = { ...r, y: +((1 - r.h) / 2).toFixed(4) };
    else if (f === "zin" || f === "zout") { // zoom manteniendo el centro del recuadro
      const h = Math.min(1, f === "zin" ? r.h * 0.9 : r.h / 0.9), w = h * asp / SRC_AR;
      fr[z] = fitRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }, asp, "topleft");
    }
    else if (f === "full") fr[z] = fullRect(asp, 0.5);
    else if (f === "reset") fr = normalizeFrame({ ...fr, [z]: undefined }, { facecam: status.config.facecam, cropX: 0.5 });
    else if (f === "pic") { picIdx++; return loadPic(); }
    else if (f === "default") {
      const facecam = { ...fr.cam, camH: fr.camH };
      await api("/api/config", { method: "POST", body: { facecam } });
      status.config.facecam = facecam;
      return toast("Listo: los clips nuevos usan esta cámara ✅");
    }
    frameChanged();
  });
  $(".f-camH", el).addEventListener("input", (ev) => {
    ev.stopPropagation();
    fr = normalizeFrame({ ...fr, camH: +ev.target.value }, { facecam: status.config.facecam });
    frameChanged();
  });
  framer.addEventListener("keydown", (ev) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!d || ev.target.matches("input,select,textarea")) return;
    ev.preventDefault();
    const step = ev.shiftKey ? 0.02 : 0.004, r = fr[selZone];
    fr[selZone] = fitRect({ ...r, x: r.x + d[0] * step, y: r.y + d[1] * step }, aspectOf(selZone), "topleft");
    frameChanged();
  });
  $(".load-preview", el).onclick = (e) => { e.target.remove(); $(".stage", el).dataset.loaded = "1"; layoutStage(); };

  // Guardar cambios
  let saveT;
  const fields = () => ({
    titulo: $(".f-titulo", el).value, gancho: $(".f-gancho", el).value, descripcion: $(".f-descripcion", el).value,
    start: parseT($(".f-start", el).value), end: parseT($(".f-end", el).value), layout: $(".f-layout", el).value,
    frame: fr, selected: $(".f-selected", el).checked,
    hookOn: $(".f-hookOn", el).checked, hookDur: +$(".f-hookDur", el).value, hookY: tx.hookY,
    subsOn: $(".f-subsOn", el).checked, subScale: +$(".f-subScale", el).value, subStyle: $(".f-subStyle", el).value || null, subY: tx.subY,
  });
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => api(`/api/streams/${vodId}/moments/${m.id}`, { method: "PATCH", body: fields() }).catch((e) => toast(e.message)), 400);
  };

  // Arrastrar título / subtítulos en el boceto (1 px del boceto = 5 px del video)
  for (const [sel, key, min, max] of [[".hook", "hookY", 90, 1000], [".sub", "subY", 300, 1820]]) {
    const node = $(sel, el);
    node.addEventListener("pointerdown", (ev) => {
      ev.preventDefault(); node.setPointerCapture(ev.pointerId); node.classList.add("dragging");
      const top = $(".screen", el).getBoundingClientRect().top;
      const move = (e2) => { tx[key] = Math.round(Math.max(min, Math.min(max, (e2.clientY - top) * 5)) / 10) * 10; updatePreview(); };
      const up = () => { node.classList.remove("dragging"); node.removeEventListener("pointermove", move); node.removeEventListener("pointerup", up); save(); };
      node.addEventListener("pointermove", move); node.addEventListener("pointerup", up);
    });
    node.addEventListener("dblclick", () => { tx[key] = key === "hookY" ? 250 : null; updatePreview(); save(); });
  }

  // Editor de subtítulos: cada línea con desde/hasta (segundos desde el inicio del clip) y texto
  const subsBox = $(".subs-editor", el), subsList = $(".subs-list", el);
  const clip0 = () => parseT($(".f-start", el).value);
  const r1 = (v) => Math.round(v * 10) / 10;
  const drawSubs = () => {
    const s0 = clip0();
    subsList.innerHTML = (tx.subs || []).map((s, i) => `<div class="sub-row" data-i="${i}">
      <input type="number" step="0.1" class="s-a" value="${r1(s.start - s0)}">
      <input type="number" step="0.1" class="s-b" value="${r1(s.end - s0)}">
      <input class="s-t" value="${esc(s.text)}">
      <button class="s-x" title="Borrar línea">✕</button></div>`).join("") || `<p class="muted" style="margin:4px 0">Sin líneas. Agregá una o volvé a transcribir.</p>`;
  };
  let subsT;
  const saveSubs = () => {
    clearTimeout(subsT);
    subsT = setTimeout(async () => {
      try { await api(`/api/streams/${vodId}/moments/${m.id}`, { method: "PATCH", body: { subs: tx.subs } }); m.subsEdited = true; $(".subs-status", el).textContent = "Guardado ✅"; updatePreview(); }
      catch (e) { toast(e.message); }
    }, 500);
  };
  subsList.addEventListener("input", (e) => {
    e.stopPropagation();
    const row = e.target.closest(".sub-row"); if (!row) return;
    const s = tx.subs[+row.dataset.i], s0 = clip0();
    if (e.target.classList.contains("s-a")) s.start = s0 + (+e.target.value || 0);
    if (e.target.classList.contains("s-b")) s.end = s0 + (+e.target.value || 0);
    if (e.target.classList.contains("s-t")) s.text = e.target.value;
    $(".subs-status", el).textContent = "…"; saveSubs();
  });
  subsList.addEventListener("click", (e) => {
    if (!e.target.classList.contains("s-x")) return;
    tx.subs.splice(+e.target.closest(".sub-row").dataset.i, 1); drawSubs(); saveSubs();
  });
  $(".act-sub-add", el).onclick = () => {
    const s0 = clip0(), last = tx.subs?.at(-1);
    const a = last ? last.end : s0;
    (tx.subs ||= []).push({ start: a, end: a + 2, text: "" }); drawSubs();
    subsList.lastElementChild?.querySelector(".s-t")?.focus();
  };
  const loadSubs = async (force) => {
    $(".subs-status", el).textContent = "Escuchando el clip… (puede tardar un minuto)";
    clearTimeout(saveT); await api(`/api/streams/${vodId}/moments/${m.id}`, { method: "PATCH", body: fields() });
    const job = await api(`/api/streams/${vodId}/moments/${m.id}/subs`, { method: "POST", body: { force } });
    watch(job, (j) => {
      if (j.status !== "done") { $(".subs-status", el).textContent = "❌ " + (j.error || j.status); return; }
      tx.subs = j.result.subs; m.subsEdited = false; $(".subs-status", el).textContent = ""; drawSubs(); updatePreview();
    });
  };
  $(".act-subs", el).onclick = () => {
    subsBox.classList.toggle("hidden");
    if (!subsBox.classList.contains("hidden")) { if (tx.subs) drawSubs(); else loadSubs(false); }
  };
  $(".act-sub-redo", el).onclick = () => { if (confirm("¿Volver a transcribir? Se pierden los cambios que hiciste en los subtítulos.")) loadSubs(true); };
  el.addEventListener("input", (e) => { if (e.target.matches("input,select,textarea")) { updatePreview(); save(); el.classList.toggle("is-selected", $(".f-selected", el).checked); } });
  el.addEventListener("change", (e) => { if (e.target.matches(".f-start,.f-end") && $(".stage", el).dataset.loaded) layoutStage(); });
  el.querySelectorAll(".nudge button").forEach((b) => b.onclick = () => {
    const [k, d] = b.dataset.n.split(":"); const inp = $(".f-" + k, el);
    inp.value = fmt(parseT(inp.value) + Number(d)); updatePreview(); save();
    if ($(".stage", el).dataset.loaded) layoutStage();
  });
  updatePreview();

  // Render + subida
  const showResult = (url, file, caption) => {
    const r = $(".result", el); r.classList.remove("hidden");
    $("video", r).src = url + "&v=" + Date.now();
    const text = caption || `${$(".f-titulo", el).value}\n\n${$(".f-descripcion", el).value}\n\n${(m.hashtagsFinal || []).join(" ")}`;
    const up = async (k) => { await copy(text); await api("/api/reveal", { method: "POST", body: { path: file } }); window.open(UPLOAD[k], "_blank"); toast(k === "ig" ? "Texto copiado. En Instagram tocá ➕ Crear y arrastrá el video desde la carpeta." : "Texto copiado. Arrastrá el video desde la carpeta que se abrió."); };
    $(".act-yt", r).onclick = () => up("yt");
    $(".act-ig", r).onclick = () => up("ig");
    $(".act-tt", r).onclick = () => up("tt");
    $(".act-copy", r).onclick = () => copy(text);
    $(".act-folder", r).onclick = () => api("/api/reveal", { method: "POST", body: { path: file } });
  };
  if (m.renderedUrl) showResult(m.renderedUrl, m.rendered, m.caption);
  $(".act-render", el).onclick = async () => {
    clearTimeout(saveT); await api(`/api/streams/${vodId}/moments/${m.id}`, { method: "PATCH", body: fields() });
    const btn = $(".act-render", el); btn.disabled = true; $(".rstatus", el).textContent = "Generando… (baja solo este tramo)";
    const job = await api(`/api/streams/${vodId}/moments/${m.id}/render`, { method: "POST" });
    watch(job, (j) => {
      btn.disabled = false;
      if (j.status === "done") { $(".rstatus", el).textContent = "✅ Guardado en tu PC"; showResult("/media?p=" + encodeURIComponent(j.result.file), j.result.file, j.result.caption); }
      else $(".rstatus", el).textContent = "❌ " + (j.error || j.status);
    });
  };
  return el;
}

// ---------- Hashtags ----------
async function viewHashtags() {
  const h = await api("/api/hashtags");
  const group = (title, arr) => `<div class="ht-group"><h3>${title}</h3><div class="tags">${(arr || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div></div>`;
  view.innerHTML = `<h1>Hashtags en tendencia</h1>
    <div class="card">
      <div class="row"><span class="muted">Actualizado: <b>${esc(h.actualizado)}</b></span><span style="flex:1"></span>
      <button class="primary" id="refresh" ${status.webSearch ? "" : "disabled title='Buscar en la web necesita Claude; la IA local no navega'"}>🔎 Investigar tendencias de hoy</button></div>
      ${status.webSearch ? "" : `<p class="muted" style="font-size:12px">La IA local no puede buscar en la web: se usa la lista base de la temporada actual. Con Claude se actualiza sola cada día.</p>`}
      <p>${esc(h.contexto || "")}</p>
    </div>
    <div class="grid2">
      <div class="card">${group("🎮 Overwatch", h.overwatch)}${group("🇦🇷🇵🇪🇺🇾 Streaming latino", h.latam_stream)}${group("🚀 Virales generales", h.virales_generales)}</div>
      <div class="card"><h3 class="muted" style="font-size:14px;margin-top:0">Combos listos (clic para copiar)</h3>
        ${Object.entries(h.combos || {}).map(([k, v]) => `<div class="muted" style="font-size:12px">${esc(k)}</div><div class="combo">${esc(v)}</div>`).join("")}
        ${(h.fuentes || []).length ? `<h3 class="muted" style="font-size:14px">Fuentes</h3><ul>${h.fuentes.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></li>`).join("")}</ul>` : ""}
      </div>
    </div>
    <p class="muted">Cada clip combina estos hashtags con los que Claude sugiere para ese momento. Clic en un hashtag para copiarlo.</p>`;
  view.onclick = (e) => { if (e.target.classList.contains("chip") || e.target.classList.contains("combo")) copy(e.target.textContent); };
  $("#refresh").onclick = async () => { const job = await api("/api/hashtags/refresh", { method: "POST" }); watch(job, (j) => { if (j.status === "error") toast(j.error); route(); }); };
}

// ---------- Configuración ----------
async function viewConfig() {
  const c = status.config;
  view.onclick = null;
  view.innerHTML = `<h1>Configuración</h1>
  <div class="grid2">
    <div class="card">
      <h2 style="margin-top:0">🧠 IA que analiza el humor</h2>
      <label>Usar <select id="aiProvider">${[["auto", "Automático (Claude si hay key, si no la local)"], ["ollama", "IA local gratis (Ollama)"], ["claude", "Claude (API, con créditos)"], ["none", "Ninguna (solo señales de chat/audio)"]].map(([v, t]) => `<option value="${v}" ${v === (c.aiProvider || "auto") ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <p style="font-size:13px">Ahora: <b>${status.aiProvider === "claude" ? "Claude" : status.aiProvider === "ollama" ? "IA local ✅" : "ninguna"}</b> ·
        Ollama: ${status.ollama?.up ? `✅ funcionando (${status.ollama.models.length} modelos)` : `❌ no detectado — instalalo con <code>winget install Ollama.Ollama</code>`}</p>
      <label>Modelo local
        <input id="ollamaModel" list="ollamaModels" value="${esc(c.ollamaModel)}">
        <datalist id="ollamaModels">${[...new Set(["qwen3:8b", "qwen3:4b", ...(status.ollama?.models || [])])].map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      </label>
      ${status.ollama?.up && !(status.ollama.models || []).some((m) => m.split(":")[0] === c.ollamaModel.split(":")[0]) ? `<p class="banner" style="font-size:13px">Falta bajar el modelo: <code>ollama pull ${esc(c.ollamaModel)}</code></p>` : ""}
      <p class="muted" style="font-size:12px">qwen3:8b (~5 GB) entiende mejor la jerga; qwen3:4b (~2.5 GB) es el doble de rápido. Corre 100% en tu PC, gratis.</p>
      <h2>🤖 Claude (opcional, mejor calidad)</h2>
      <label>API key de Anthropic ${c.hasAnthropicKey ? "✅" : ""}<input id="anthropicApiKey" type="password" value="${esc(c.anthropicApiKey)}" placeholder="sk-ant-…  (o dejá vacío si usás ANTHROPIC_API_KEY)"></label>
      <label>Modelo <input id="claudeModel" value="${esc(c.claudeModel)}"></label>
      <label>Esfuerzo de análisis <select id="claudeEffort">${["low", "medium", "high", "xhigh", "max"].map((x) => `<option ${x === c.claudeEffort ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <p class="muted" style="font-size:12px">La key se guarda solo en <code>data/config.json</code> en tu PC. Conseguila en console.anthropic.com.</p>
      <h2>🎙️ Transcripción local (Whisper)</h2>
      <label>Modelo <select id="whisperModel">${["Xenova/whisper-base", "Xenova/whisper-small", "Xenova/whisper-medium"].map((x) => `<option ${x === c.whisperModel ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <p class="muted" style="font-size:12px">small = buen equilibrio. medium entiende mejor la jerga pero es más lento en CPU.</p>
    </div>
    <div class="card">
      <h2 style="margin-top:0">🟣 Twitch</h2>
      <p style="font-size:13px">${status.user ? `Conectado como <b>${esc(status.user.display_name)}</b> ✅` : status.twitchLogin ? `Tocá <b>Conectar Twitch</b> arriba a la derecha: te da un código y lo confirmás en twitch.tv/activate.` : `Falta el ID público de la app en el código.`}</p>
      <details><summary class="muted" style="cursor:pointer;font-size:13px">Avanzado: usar tu propia app de Twitch</summary>
        <p class="muted" style="font-size:12px">Solo si querés usar otra app de <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv</a>. Pública: pegá solo el Client ID. Confidencial: Client ID + Secret y la redirección <code>${esc(c.redirectUri)}</code>.</p>
        <label>Client ID <input id="twitchClientId" value="${esc(c.twitchClientId)}" placeholder="(vacío = el incluido en la app)"></label>
        <label>Client Secret <input id="twitchClientSecret" type="password" value="${esc(c.twitchClientSecret)}"></label>
      </details>
      <label>Canal por defecto <input id="channel" value="${esc(c.channel)}"></label>
      <h2>🎬 Clips</h2>
      <label>Carpeta donde se guardan <input id="outputDir" value="${esc(c.outputDir)}"></label>
      <div class="row">
        <label style="flex:1">Duración mín (s) <input id="minClipSec" type="number" value="${c.minClipSec}"></label>
        <label style="flex:1">Duración máx (s) <input id="maxClipSec" type="number" value="${c.maxClipSec}"></label>
        <label style="flex:1">Retraso del chat (s) <input id="chatDelaySec" type="number" value="${c.chatDelaySec}"></label>
      </div>
      <label>Formato por defecto <select id="defaultLayout">${[["blur", "Fondo desenfocado"], ["crop", "Recorte centrado"], ["facecam", "Facecam + juego"]].map(([v, t]) => `<option value="${v}" ${v === c.defaultLayout ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Color de subtítulos <select id="subtitleStyle">${["amarillo", "blanco", "verde"].map((x) => `<option ${x === c.subtitleStyle ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    </div>
  </div>
  <div class="card">
    <h2 style="margin-top:0">📷 Ubicación de tu facecam</h2>
    <p class="muted" style="font-size:13px">Para el formato "Facecam + juego". Poné el ID de un VOD y arrastrá sobre la imagen para marcar dónde está tu cámara.</p>
    <div class="row"><input id="fcVod" placeholder="ID de VOD" style="max-width:200px"><button id="fcLoad">Cargar imagen</button><span class="muted" id="fcVal">x=${c.facecam.x} y=${c.facecam.y} w=${c.facecam.w} h=${c.facecam.h}</span></div>
    <div class="facecam-pick" id="fcPick"></div>
  </div>
  <button class="primary" id="save">Guardar</button>`;
  let facecam = { ...c.facecam };
  $("#fcLoad").onclick = () => {
    const id = ($("#fcVod").value.match(/\d+/) || [])[0]; if (!id) return;
    $("#fcPick").innerHTML = `<p class="muted">Sacando un frame del VOD…</p>`;
    const img = new Image(); img.src = `/api/streams/${id}/frame?t=900`;
    img.onload = () => {
      $("#fcPick").innerHTML = ""; $("#fcPick").appendChild(img);
      const rect = document.createElement("div"); rect.className = "rect"; $("#fcPick").appendChild(rect);
      const draw = () => Object.assign(rect.style, { left: facecam.x * 100 + "%", top: facecam.y * 100 + "%", width: facecam.w * 100 + "%", height: facecam.h * 100 + "%" });
      draw();
      let st = null;
      img.onmousedown = (e) => { e.preventDefault(); const b = img.getBoundingClientRect(); st = [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height]; };
      window.onmousemove = (e) => { if (!st) return; const b = img.getBoundingClientRect(); const p = [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height].map((v) => Math.max(0, Math.min(1, v)));
        facecam = { x: +Math.min(st[0], p[0]).toFixed(3), y: +Math.min(st[1], p[1]).toFixed(3), w: +Math.abs(p[0] - st[0]).toFixed(3), h: +Math.abs(p[1] - st[1]).toFixed(3) }; draw();
        $("#fcVal").textContent = `x=${facecam.x} y=${facecam.y} w=${facecam.w} h=${facecam.h}`; };
      window.onmouseup = () => { st = null; };
    };
    img.onerror = () => { $("#fcPick").innerHTML = `<p class="muted">No pude sacar la imagen (¿ffmpeg instalado? ¿VOD válida?).</p>`; };
  };
  $("#save").onclick = async () => {
    const body = { facecam };
    for (const k of ["aiProvider", "ollamaModel", "anthropicApiKey", "claudeModel", "claudeEffort", "whisperModel", "twitchClientId", "twitchClientSecret", "channel", "outputDir", "minClipSec", "maxClipSec", "chatDelaySec", "defaultLayout", "subtitleStyle"]) body[k] = $("#" + k).value;
    await api("/api/config", { method: "POST", body });
    toast("Guardado ✅"); route();
  };
}

pollJobs();
route();
