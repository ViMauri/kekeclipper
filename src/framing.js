// Encuadre de los Shorts: qué parte del video original va en cada zona del 9:16.
// Lo usan el servidor (ffmpeg) y la interfaz (editor y boceto), así lo que ves es lo que sale.
// Todos los rectángulos están en fracciones del video original (0..1), que es 16:9.

export const OUT_W = 1080, OUT_H = 1920;
export const SRC_AR = 16 / 9;
export const CAM_H_MIN = 400, CAM_H_MAX = 1100, CAM_H_DEFAULT = 700;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

/** Proporción (ancho/alto en píxeles de salida) que debe tener cada zona. */
export function zoneAspect(zone, camH = CAM_H_DEFAULT) {
  if (zone === "crop") return OUT_W / OUT_H;
  if (zone === "cam") return OUT_W / camH;
  if (zone === "game") return OUT_W / (OUT_H - camH);
  return SRC_AR; // fg (fondo desenfocado): el video tal cual, con zoom opcional
}

/**
 * Ajusta un rectángulo a la proporción de su zona, sin deformar la imagen.
 * keep: "center" (mantiene el centro) o "topleft" (mantiene la esquina, para agrandar arrastrando).
 */
export function fitRect(r, aspect, keep = "center") {
  // en fracciones del original: w / h = aspect / SRC_AR
  const k = aspect / SRC_AR;
  let h = clamp(Number(r.h) || 1, 0.05, 1);
  let w = h * k;
  if (w > 1) { w = 1; h = w / k; }
  if (w < 0.04) { w = 0.04; h = w / k; }
  const cx = (Number(r.x) || 0) + (Number(r.w) || w) / 2, cy = (Number(r.y) || 0) + (Number(r.h) || h) / 2;
  let x = keep === "center" ? cx - w / 2 : Number(r.x) || 0;
  let y = keep === "center" ? cy - h / 2 : Number(r.y) || 0;
  x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - h);
  return { x: r4(x), y: r4(y), w: r4(w), h: r4(h) };
}

/** Rectángulo más grande posible para la zona, centrado (o en la posición horizontal cx 0..1). */
export function fullRect(aspect, cx = 0.5) {
  const r = fitRect({ x: 0, y: 0, w: 1, h: 1 }, aspect);
  return { ...r, x: r4((1 - r.w) * clamp(cx, 0, 1)), y: r4((1 - r.h) / 2) };
}

/**
 * Encuadre completo de un clip. `saved` es lo que guardó el usuario (puede faltar todo o una parte).
 * `facecam` es la cámara por defecto de Configuración; `cropX` el encuadre horizontal viejo (compatibilidad).
 */
export function normalizeFrame(saved = {}, { facecam, cropX = 0.5 } = {}) {
  const s = saved || {};
  const camH = Math.round(clamp(Number(s.camH ?? facecam?.camH) || CAM_H_DEFAULT, CAM_H_MIN, CAM_H_MAX) / 10) * 10;
  const fc = facecam || { x: 0, y: 0, w: 0.28, h: 0.3 };
  const camDefault = fitRect({ x: fc.x, y: fc.y, w: fc.w, h: fc.h }, zoneAspect("cam", camH));
  return {
    camH,
    crop: s.crop ? fitRect(s.crop, zoneAspect("crop")) : fullRect(zoneAspect("crop"), cropX),
    cam: s.cam ? fitRect(s.cam, zoneAspect("cam", camH)) : camDefault,
    game: s.game ? fitRect(s.game, zoneAspect("game", camH)) : fullRect(zoneAspect("game", camH), cropX),
    fg: s.fg ? fitRect(s.fg, zoneAspect("fg")) : { x: 0, y: 0, w: 1, h: 1 },
  };
}
