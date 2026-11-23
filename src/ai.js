// Claude: juez de humor latino, resumen para YouTube y búsqueda de hashtags en tendencia.
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config.js";

// ---------- Proveedores: Claude (API paga) u Ollama (gratis, local) ----------
export function hasClaudeKey() {
  const c = getConfig();
  return Boolean(c.anthropicApiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let ollamaState = { up: false, models: [], checkedAt: 0 };
export async function checkOllama() {
  const url = getConfig().ollamaUrl || "http://127.0.0.1:11434";
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    ollamaState = { up: true, models: (j.models || []).map((m) => m.name), checkedAt: Date.now() };
  } catch { ollamaState = { up: false, models: [], checkedAt: Date.now() }; }
  return ollamaState;
}
export function ollamaInfo() { return ollamaState; }

function ollamaReady() {
  const want = getConfig().ollamaModel;
  return ollamaState.up && ollamaState.models.some((m) => m === want || m === `${want}:latest` || m.split(":")[0] === want);
}

/** "claude" | "ollama" | null según la configuración y lo que esté disponible. */
export function aiProvider() {
  const p = getConfig().aiProvider || "auto";
  if (p === "none") return null;
  if (p === "claude") return hasClaudeKey() ? "claude" : null;
  if (p === "ollama") return ollamaReady() ? "ollama" : null;
  return hasClaudeKey() ? "claude" : ollamaReady() ? "ollama" : null;
}
export function aiAvailable() { return aiProvider() !== null; }
export function webSearchAvailable() { return aiProvider() === "claude"; }

/**
 * Los modelos locales chicos pueden quedarse generando una lista o un texto sin fin
 * (ej. hashtags infinitos). Se les ponen topes en el esquema.
 */
function limitSchema(s, key = "") {
  if (!s || typeof s !== "object") return s;
  const o = { ...s };
  if (o.type === "string" && !o.enum && o.maxLength == null) o.maxLength = { titulo: 90, gancho: 45, miniatura_texto: 40 }[key] || 320;
  if (o.type === "array") {
    if (o.maxItems == null) o.maxItems = key === "moments" ? 12 : key === "orden" ? 30 : 8;
    o.items = limitSchema(o.items, key === "hashtags" || key === "tags" ? "tag" : key);
  }
  if (o.properties) o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, limitSchema(v, k)]));
  if (key === "tag" && o.type === "string") o.maxLength = 30;
  return o;
}

async function ollamaJson(system, user, schema) {
  const cfg = getConfig();
  schema = limitSchema(schema);
  const body = {
    // stream: true → Ollama manda tokens a medida que los genera, así la conexión no se corta
    // por inactividad aunque la PC tarde varios minutos en responder.
    model: cfg.ollamaModel, stream: true, think: false, format: schema, keep_alive: "30m",
    options: { num_ctx: 8192, temperature: 0.3, num_predict: 1800 }, // tope duro por si igual se va de largo
    messages: [{ role: "system", content: system }, { role: "user", content: user + "\n\nRespondé solo con el JSON pedido." }],
  };
  const url = `${cfg.ollamaUrl || "http://127.0.0.1:11434"}/api/chat`;
  let r = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok && /think/i.test(await r.clone().text())) { delete body.think; r = await fetch(url, { method: "POST", body: JSON.stringify(body) }); }
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  let content = "", buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error("Ollama: " + ev.error);
      content += ev.message?.content || "";
      if (ev.done) console.log(`[ia-local] prompt ${ev.prompt_eval_count} tok en ${Math.round(ev.prompt_eval_duration / 1e9)}s, respuesta ${ev.eval_count} tok en ${Math.round(ev.eval_duration / 1e9)}s`);
    }
  }
  const data = parseJsonLoose(content.replace(/<think>[\s\S]*?<\/think>/g, ""));
  if (!data) throw new Error("La IA local devolvió algo ilegible");
  return data;
}

/** Cuántos momentos se mandan por pedido (los modelos locales rinden mejor de a pocos). */
export function batchSize() { return aiProvider() === "ollama" ? 2 : 5; }

function client() {
  const key = getConfig().anthropicApiKey;
  return key ? new Anthropic({ apiKey: key }) : new Anthropic();
}

const HUMOR_SYSTEM = `Sos editor/a de clips para un streamer latinoamericano de Twitch (juega mucho Overwatch, también otros juegos y charla).
Tu trabajo: decidir qué momentos dan risa DE VERDAD y convertirlos en Shorts/Reels/TikToks virales.

Conocés a fondo el humor latino: rioplatense (Argentina/Uruguay: bardeo, ironía, "boludo", "la concha de…", "qué hacés, salame"), peruano ("causa", "csm", jerga, criollada), chileno ("weón", "ctm"), mexicano ("nmms", albur), colombiano, etc.
El contenido es para mayores de 18: las malas palabras, el humor negro, los insultos entre amigos y lo subido de tono son PARTE del humor y NO restan puntos. Usalos con naturalidad en títulos y ganchos si suman.

Cómo analizar cada momento (tomate tu tiempo):
1. Leé la transcripción y el chat. Si hay muchas risas (en audio o "JAJAJA"/KEKW en el chat), averiguá POR QUÉ: ¿fue un chiste armado en el momento (remate improvisado, comentario rápido, bardeo), una reacción exagerada, un fail en el juego (Overwatch: whiff, muerte absurda, ult desperdiciada, play ridícula, tóxicos en el voice), algo de un donador/TTS, o un error técnico?
2. Si es un chiste, encontrá el ARRANQUE (la premisa / lo que lo provoca) y el REMATE. El clip tiene que empezar justo antes del arranque —con contexto suficiente para que alguien que no vio el stream lo entienda— y terminar poco después de la risa (no dejes 10 segundos de silencio al final).
3. Si el chiste depende de algo que pasó ANTES de la ventana que ves, marcá needs_more_context=true.
4. Puntaje 0-10: 9-10 viral seguro; 7-8 muy bueno; 5-6 sirve de relleno; <5 no vale la pena. Sé exigente: el chat de Twitch se ríe de cualquier cosa, el público de Shorts no.
5. Duración del clip: entre MIN y MAX segundos (te los paso). Mejor corto y picante que largo.
6. Título: corto (máx 70 caracteres), con gancho, en el idioma y la jerga del streamer, puede tener 1-2 emojis. Gancho: texto de 2-6 palabras que va arriba del video los primeros segundos.
7. Descripción: 1-2 frases, natural, sin hashtags (los hashtags van en su campo).
Los tiempos start y end que devolvés son SEGUNDOS ABSOLUTOS del VOD: usá el número que aparece como "= 1234s" en las marcas de la transcripción (por ejemplo, si el chiste arranca en [1:39:42 = 5982s] → start: 5978). Nunca uses tiempos relativos ni minutos.`;

const MOMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moments"],
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "keep", "score", "tipo", "needs_more_context", "start", "end", "titulo", "gancho", "descripcion", "hashtags", "por_que"],
        properties: {
          id: { type: "integer" },
          keep: { type: "boolean" },
          score: { type: "number" },
          tipo: { type: "string", enum: ["chiste", "reaccion", "fail", "bardeo", "jugada", "situacion", "donacion", "otro"] },
          needs_more_context: { type: "boolean" },
          start: { type: "number" },
          end: { type: "number" },
          titulo: { type: "string" },
          gancho: { type: "string" },
          descripcion: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          por_que: { type: "string" },
        },
      },
    },
  },
};

async function create(params) {
  const c = client();
  const base = { model: getConfig().claudeModel || "claude-opus-5-5", max_tokens: 16000, ...params };
  base.output_config = { effort: getConfig().claudeEffort || "high", ...(params.output_config || {}) };
  try {
    // Fallback del lado del servidor: si un modelo declina por política, otro sigue (opt-in recomendado)
    return await c.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) return c.messages.create(base);
    throw e;
  }
}

function textOf(resp) {
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch {}
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s) || /(\{[\s\S]*\})/.exec(s);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  return null;
}

async function jsonCall(system, user, schema) {
  if (aiProvider() === "ollama") return ollamaJson(system, user, schema);
  const resp = await create({
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema } },
  });
  if (resp.stop_reason === "refusal") throw new Error("Claude declinó analizar este bloque" + (resp.stop_details?.explanation ? `: ${resp.stop_details.explanation}` : ""));
  const data = parseJsonLoose(textOf(resp));
  if (!data) throw new Error("Respuesta de Claude ilegible");
  return data;
}

/**
 * Juzga un lote de candidatos.
 * items: [{ id, windowStart, windowEnd, transcript (texto con marcas), chat: [{t,user,text}], signal }]
 */
export async function judgeMoments(items, { minSec, maxSec, streamTitle, game }) {
  const fmt = (s) => { s = Math.floor(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const blocks = items.map((it) => [
    `### Momento id=${it.id}  (ventana ${fmt(it.windowStart)} = ${Math.round(it.windowStart)}s → ${fmt(it.windowEnd)} = ${Math.round(it.windowEnd)}s, pico de risa en ${Math.round(it.peak)}s, señal ${it.signal})`,
    `Transcripción del streamer:\n${it.transcript || "(sin voz detectada)"}`,
    `Chat en ese momento:\n${it.chat.map((m) => `[${fmt(m.t)} = ${Math.round(m.t)}s] ${m.user}: ${m.text}`).join("\n") || "(sin chat)"}`,
  ].join("\n"));
  const user = `Stream: "${streamTitle}"${game ? ` — juego: ${game}` : ""}
Duración de clip permitida: MIN=${minSec}s, MAX=${maxSec}s.
Analizá cada momento y devolvé uno por id.

${blocks.join("\n\n")}`;
  const data = await jsonCall(HUMOR_SYSTEM, user, MOMENT_SCHEMA);
  return data.moments || [];
}

/** Modo profundo: Claude lee un bloque largo de transcripción y propone momentos (aunque el chat no haya reaccionado). */
export async function scanTranscriptBlock({ transcript, chat, blockStart, blockEnd, minSec, maxSec, streamTitle }) {
  const fmt = (s) => { s = Math.floor(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const schema = {
    type: "object", additionalProperties: false, required: ["moments"],
    properties: { moments: { type: "array", items: { type: "object", additionalProperties: false, required: ["start", "end", "score", "por_que"], properties: { start: { type: "number" }, end: { type: "number" }, score: { type: "number" }, por_que: { type: "string" } } } } },
  };
  const user = `Stream "${streamTitle}". Bloque ${fmt(blockStart)} → ${fmt(blockEnd)}.
Buscá momentos graciosos (chistes improvisados, remates, bardeo, fails) aunque el chat no haya reaccionado. Solo puntaje ≥6. Clips de ${minSec}-${maxSec}s. Si no hay nada bueno devolvé lista vacía.

Transcripción:
${transcript}

Picos de risa del chat (resumen):
${chat.map((m) => `[${fmt(m.t)}] ${m.text}`).join("\n") || "(nada)"}`;
  const data = await jsonCall(HUMOR_SYSTEM, user, schema);
  return data.moments || [];
}

/** Resumen del directo para YouTube: título, descripción, capítulos y qué momentos usar. */
export async function summarizeStream({ streamTitle, game, duration, moments, timeline, maxMinutes = 10 }) {
  const schema = {
    type: "object", additionalProperties: false,
    required: ["titulo", "descripcion", "resumen", "orden", "tags", "miniatura_texto"],
    properties: {
      titulo: { type: "string" }, descripcion: { type: "string" }, resumen: { type: "string" },
      orden: { type: "array", items: { type: "integer" } },
      tags: { type: "array", items: { type: "string" } },
      miniatura_texto: { type: "string" },
    },
  };
  const user = `Armá el "resumen del directo" para subir a YouTube (video horizontal de MÁXIMO ${maxMinutes} minutos con los mejores momentos, que se entienda como historia y no pierda ritmo).
Stream: "${streamTitle}"${game ? ` (${game})` : ""}, duración ${Math.round(duration / 60)} min.

Momentos disponibles (id, tiempo, puntaje, tipo, título, por qué):
${moments.map((m) => `- id=${m.id} @${Math.round(m.start)}s-${Math.round(m.end)}s score=${m.score} ${m.tipo}: ${m.titulo} — ${m.por_que}`).join("\n")}

Cómo fue el stream a lo largo del tiempo (temas del chat por tramo):
${timeline}

Devolvé:
- titulo: título de YouTube con gancho (máx 90 caracteres), estilo latino, puede tener puteadas si suma.
- descripcion: 3-6 líneas para la descripción (sin capítulos ni hashtags, los agrego yo).
- resumen: resumen narrativo del directo en 1 párrafo.
- orden: ids de los momentos que SÍ valen la pena (los más graciosos y los que dan contexto para entender a los demás), del más importante al menos importante. Sumados no deben pasar de ${maxMinutes} min; el video se arma en orden cronológico.
- tags: 10-15 tags de YouTube.
- miniatura_texto: 2-4 palabras para la miniatura.`;
  return jsonCall(HUMOR_SYSTEM, user, schema);
}

/** Investiga en la web los hashtags en tendencia HOY (Overwatch + streaming latino). */
export async function researchHashtags(today) {
  if (!webSearchAvailable()) throw new Error("Buscar tendencias en la web necesita Claude (la IA local no navega). Uso la lista base.");
  const user = `Hoy es ${today}. Investigá en la web qué hashtags están funcionando AHORA (esta semana) para:
1) Overwatch (temporada actual, héroes nuevos/meta, eventos, colaboraciones, esports) en TikTok, YouTube Shorts e Instagram Reels.
2) Clips de streamers latinoamericanos / Twitch en español / gaming LATAM (Argentina, Perú, Uruguay, México, Chile).
Priorizá hashtags con MUCHO alcance pero que todavía apunten al nicho (gaming en español), y evitá los muertos o spam.
Respondé SOLO con un bloque \`\`\`json con esta forma:
{"actualizado": "${today}", "contexto": "1-2 frases sobre qué está pasando en Overwatch ahora",
 "overwatch": ["#..."], "latam_stream": ["#..."], "virales_generales": ["#..."],
 "combos": {"shorts": "#a #b #c ...", "instagram": "...", "tiktok": "..."}, "fuentes": ["url", ...]}`;
  const c = client();
  const messages = [{ role: "user", content: user }];
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }];
  let resp;
  for (let i = 0; i < 4; i++) {
    resp = await c.messages.create({ model: getConfig().claudeModel || "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "medium" }, tools, messages });
    if (resp.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: resp.content });
  }
  if (resp.stop_reason === "refusal") throw new Error("Claude declinó la búsqueda de hashtags");
  const data = parseJsonLoose(textOf(resp));
  if (!data) throw new Error("No pude leer los hashtags investigados");
  return data;
}
