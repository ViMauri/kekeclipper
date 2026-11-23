// Acceso a Twitch: cuenta (OAuth/Helix), lista de VODs, chat del VOD y playlist HLS.
// Nada de esto descarga la VOD: el video/audio se lee por streaming desde los servidores de Twitch.
import path from "node:path";
import { getConfig, DATA_DIR, readJson, writeJson, PORT } from "./config.js";

// Client-ID público del reproductor web de Twitch (el mismo que usan yt-dlp / streamlink / TwitchDownloader)
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL = "https://gql.twitch.tv/gql";
const SESSION_FILE = path.join(DATA_DIR, "twitch_session.json");

// ---------------- OAuth (conectar tu cuenta) ----------------
// ID público de la app "KekeClipper" en dev.twitch.tv (tipo de cliente: Público).
// No es secreto: identifica a la app, no a la persona. Cada usuario autoriza con SU cuenta.
export const PUBLIC_CLIENT_ID = "ebao1hkfh9wt9yps8q2jzib0752yjc";
const SCOPES = "user:read:email";

/** Client ID efectivo: el de Configuración (avanzado) o el público incluido. */
export function clientId() {
  return getConfig().twitchClientId || PUBLIC_CLIENT_ID;
}
const hasSecret = () => Boolean(getConfig().twitchClientId && getConfig().twitchClientSecret);

async function saveSessionFromToken(tok, cid) {
  const session = { ...tok, client_id: cid, obtained_at: Date.now() };
  const me = await helix("/users", {}, session.access_token, cid);
  session.user = me.data?.[0] || null;
  writeJson(SESSION_FILE, session);
  return session;
}

// --- Login por código de dispositivo (no necesita secreto ni URL de redirección) ---
let pendingDevice = null;
export async function startDeviceLogin() {
  const cid = clientId();
  if (!cid) throw new Error("Falta el Client ID público de Twitch.");
  const r = await fetch("https://id.twitch.tv/oauth2/device", { method: "POST", body: new URLSearchParams({ client_id: cid, scopes: SCOPES }) });
  if (!r.ok) throw new Error("Twitch no inició el login: " + (await r.text()));
  const d = await r.json();
  pendingDevice = { ...d, client_id: cid, expires_at: Date.now() + d.expires_in * 1000 };
  return { user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval || 5, expires_in: d.expires_in };
}

/** Devuelve { status: "pending" | "ok" | "expired" | "denied" }. */
export async function pollDeviceLogin() {
  if (!pendingDevice) return { status: "expired" };
  if (Date.now() > pendingDevice.expires_at) { pendingDevice = null; return { status: "expired" }; }
  const body = new URLSearchParams({ client_id: pendingDevice.client_id, scopes: SCOPES, device_code: pendingDevice.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) {
    const s = await saveSessionFromToken(j, pendingDevice.client_id);
    pendingDevice = null;
    return { status: "ok", user: s.user };
  }
  if (/authorization_pending|slow_down/i.test(j.message || "")) return { status: "pending" };
  if (/denied/i.test(j.message || "")) { pendingDevice = null; return { status: "denied" }; }
  if (/invalid device code|expired/i.test(j.message || "")) { pendingDevice = null; return { status: "expired" }; }
  return { status: "pending" };
}

// --- Login clásico (solo si configuraste tu propia app con secreto) ---
export function authUrl(state) {
  const twitchClientId = clientId();
  const p = new URLSearchParams({
    client_id: twitchClientId,
    redirect_uri: `http://localhost:${PORT}/auth/twitch/callback`,
    response_type: "code",
    scope: "user:read:email",
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

export async function exchangeCode(code) {
  const { twitchClientId, twitchClientSecret } = getConfig();
  const body = new URLSearchParams({
    client_id: twitchClientId,
    client_secret: twitchClientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: `http://localhost:${PORT}/auth/twitch/callback`,
  });
  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!r.ok) throw new Error("Twitch rechazó el login: " + (await r.text()));
  return saveSessionFromToken(await r.json(), twitchClientId);
}

export async function refreshIfNeeded(session) {
  if (!session?.refresh_token) return session;
  const age = (Date.now() - session.obtained_at) / 1000;
  if (age < (session.expires_in || 3600) - 120) return session;
  const cid = session.client_id || clientId();
  const p = { client_id: cid, grant_type: "refresh_token", refresh_token: session.refresh_token };
  // Las apps públicas renuevan sin secreto; las confidenciales lo necesitan
  if (hasSecret() && cid === getConfig().twitchClientId) p.client_secret = getConfig().twitchClientSecret;
  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body: new URLSearchParams(p) });
  if (!r.ok) { writeJson(SESSION_FILE, null); return null; } // hay que volver a conectar
  const tok = await r.json();
  const s = { ...session, ...tok, obtained_at: Date.now() };
  writeJson(SESSION_FILE, s);
  return s;
}

export function getSession() { return readJson(SESSION_FILE, null); }
export function logout() { writeJson(SESSION_FILE, null); }

let appToken = null;
async function getAppToken() {
  const { twitchClientId, twitchClientSecret } = getConfig();
  if (!twitchClientId || !twitchClientSecret) return null;
  if (appToken && appToken.exp > Date.now()) return appToken.token;
  const body = new URLSearchParams({ client_id: twitchClientId, client_secret: twitchClientSecret, grant_type: "client_credentials" });
  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
  if (!r.ok) return null;
  const t = await r.json();
  appToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 300) * 1000 };
  return appToken.token;
}

async function helix(pathname, params, token, cid) {
  const url = `https://api.twitch.tv/helix${pathname}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { "Client-Id": cid || getSession()?.client_id || clientId(), Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Helix ${pathname}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------- GQL (uso del reproductor web) ----------------
async function gql(payload) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "Client-Id": WEB_CLIENT_ID, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Twitch GQL ${r.status}`);
  return r.json();
}

function parseDuration(s) { // "3h2m1s" de Helix
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(s || "");
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

/** Lista los directos guardados (VODs) del canal conectado o del canal indicado. */
export async function listVods(channelLogin) {
  let session = getSession();
  if (session) session = await refreshIfNeeded(session);
  let login = (channelLogin || session?.user?.login || getConfig().channel || "").trim().toLowerCase();
  const fromUrl = /twitch\.tv\/@?([a-z0-9_]{2,25})/i.exec(login); // también acepta el link del canal
  if (fromUrl) login = fromUrl[1];
  login = login.replace(/^@/, "");

  // 1) Helix con tu cuenta o con token de app
  const token = session?.access_token || (await getAppToken());
  if (token) {
    try {
      let userId = session?.user?.id;
      if (!userId || (login && login !== session?.user?.login)) {
        const u = await helix("/users", { login }, token);
        userId = u.data?.[0]?.id;
      }
      if (userId) {
        const v = await helix("/videos", { user_id: userId, type: "archive", first: "50" }, token);
        return v.data.map((x) => ({
          id: x.id, title: x.title, createdAt: x.created_at, duration: parseDuration(x.duration),
          thumbnail: (x.thumbnail_url || "").replace("%{width}", "320").replace("%{height}", "180"),
          views: x.view_count, url: x.url, channel: x.user_login,
        }));
      }
    } catch (e) { console.warn("[twitch] Helix falló, pruebo GQL:", e.message); }
  }

  // 2) Sin app de Twitch: GQL público por nombre de canal
  if (!login) throw new Error("Conectá tu cuenta de Twitch o escribí el nombre del canal.");
  const q = `query { user(login: ${JSON.stringify(login)}) { login videos(first: 50, type: ARCHIVE, sort: TIME) { edges { node { id title lengthSeconds createdAt viewCount previewThumbnailURL(width: 320, height: 180) game { name } } } } } }`;
  const res = await gql({ query: q });
  const edges = res?.data?.user?.videos?.edges;
  if (!edges) throw new Error("No encontré VODs para ese canal (¿los VODs están activados?).");
  return edges.map(({ node: n }) => ({
    id: n.id, title: n.title, createdAt: n.createdAt, duration: n.lengthSeconds,
    thumbnail: n.previewThumbnailURL, views: n.viewCount, url: `https://www.twitch.tv/videos/${n.id}`,
    channel: login, game: n.game?.name,
  }));
}

export async function vodInfo(vodId) {
  const q = `query { video(id: ${JSON.stringify(String(vodId))}) { id title lengthSeconds createdAt owner { login displayName } game { name } previewThumbnailURL(width: 640, height: 360) } }`;
  const res = await gql({ query: q });
  const v = res?.data?.video;
  if (!v) throw new Error("VOD no encontrada o privada.");
  return { id: v.id, title: v.title, duration: v.lengthSeconds, createdAt: v.createdAt, channel: v.owner?.login, channelName: v.owner?.displayName, game: v.game?.name, thumbnail: v.previewThumbnailURL };
}

// ---------------- Playlist HLS (para leer sin descargar) ----------------
const PAT_QUERY = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }`;

const playlistCache = new Map();

/** Devuelve URLs m3u8 de la VOD: { source, audio, variants[] }. Se renuevan cada ~1h. */
export async function getPlaylists(vodId) {
  const c = playlistCache.get(vodId);
  if (c && c.exp > Date.now()) return c.data;
  const res = await gql({
    operationName: "PlaybackAccessToken_Template",
    query: PAT_QUERY,
    variables: { isLive: false, login: "", isVod: true, vodID: String(vodId), playerType: "site" },
  });
  const tok = res?.data?.videoPlaybackAccessToken;
  if (!tok) throw new Error("No pude obtener acceso a la VOD (¿es solo para suscriptores o fue borrada?).");
  const p = new URLSearchParams({
    sig: tok.signature, token: tok.value, allow_source: "true", allow_audio_only: "true",
    player: "twitchweb", playlist_include_framerate: "true", p: String(Math.floor(Math.random() * 1e6)),
  });
  const master = await (await fetch(`https://usher.ttvnw.net/vod/${vodId}.m3u8?${p}`)).text();
  if (!master.startsWith("#EXTM3U")) throw new Error("Twitch no devolvió la playlist de la VOD.");
  const lines = master.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const info = lines[i];
      const media = (/VIDEO="([^"]+)"/.exec(info) || [])[1] || "";
      const res = (/RESOLUTION=(\d+x\d+)/.exec(info) || [])[1] || "";
      const bw = +((/BANDWIDTH=(\d+)/.exec(info) || [])[1] || 0);
      variants.push({ name: media, resolution: res, bandwidth: bw, url: lines[i + 1] });
    }
  }
  const audio = variants.find((v) => v.name === "audio_only") || variants[variants.length - 1];
  const video = variants.filter((v) => v.name !== "audio_only");
  const source = video.find((v) => v.name === "chunked") || video.sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const data = { source: source?.url, audio: audio?.url, variants };
  playlistCache.set(vodId, { data, exp: Date.now() + 50 * 60 * 1000 });
  return data;
}

// ---------------- Chat del VOD ----------------
const COMMENTS_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

/**
 * Descarga la repetición del chat (solo texto, liviano). onProgress(segundos).
 * Devuelve [{ t, user, text }]. Si Twitch lo bloquea, devuelve [] y el análisis sigue solo con audio.
 */
export async function fetchChat(vodId, duration, onProgress) {
  const out = [];
  let cursor = null;
  let offset = 0;
  let mode = "cursor";
  for (let guard = 0; guard < 200000; guard++) {
    const variables = mode === "cursor" && cursor ? { videoID: String(vodId), cursor } : { videoID: String(vodId), contentOffsetSeconds: offset };
    let res;
    try {
      res = await gql({ operationName: "VideoCommentsByOffsetOrCursor", variables, extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } } });
    } catch (e) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    if (res?.errors?.length) {
      if (mode === "cursor" && cursor) { mode = "offset"; continue; } // Twitch a veces exige integridad con cursor
      break;
    }
    const comments = res?.data?.video?.comments;
    const edges = comments?.edges || [];
    for (const e of edges) {
      const n = e.node;
      const text = (n.message?.fragments || []).map((f) => f.text).join("");
      out.push({ t: n.contentOffsetSeconds, user: n.commenter?.displayName || "?", text });
    }
    if (!edges.length) break;
    const last = edges[edges.length - 1];
    onProgress?.(last.node.contentOffsetSeconds, out.length);
    if (!comments.pageInfo?.hasNextPage) break;
    cursor = last.cursor;
    const nextOffset = last.node.contentOffsetSeconds + (mode === "offset" ? 1 : 0);
    if (mode === "offset" && nextOffset <= offset) offset += 1; else offset = nextOffset;
    if (duration && last.node.contentOffsetSeconds > duration + 5) break;
  }
  // deduplicar (el paginado por offset puede repetir)
  const seen = new Set();
  return out.filter((m) => { const k = `${m.t}|${m.user}|${m.text}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.t - b.t);
}
