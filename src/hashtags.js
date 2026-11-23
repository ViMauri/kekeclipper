// Hashtags: investigación diaria con Claude + búsqueda web, con respaldo curado.
import path from "node:path";
import { DATA_DIR, readJson, writeJson } from "./config.js";
import { webSearchAvailable, researchHashtags } from "./ai.js";

const FILE = path.join(DATA_DIR, "hashtags.json");

// Respaldo (noviembre 2026: Overwatch Temporada 5 "Reinado de Talon", colab EVE Protocol, Doctrine en el meta).
// Se reemplaza automáticamente por la investigación del día cuando hay API key.
export const FALLBACK = {
  actualizado: "respaldo",
  contexto: "Overwatch T5 'Reinado de Talon' (mitad de temporada desde el 3/11/2026), colaboración EVE Protocol y cambios a Doctrine/Ana/Junker Queen.",
  overwatch: ["#Overwatch", "#OverwatchClips", "#OverwatchFunny", "#OverwatchMemes", "#ReinadoDeTalon", "#OverwatchEspañol", "#Overwatch2", "#OWClips", "#Doctrine", "#JunkerQueen", "#Ana", "#Kiriko"],
  latam_stream: ["#StreamerLatino", "#TwitchLatam", "#ClipsTwitch", "#TwitchEspañol", "#StreamersArgentinos", "#GamerArgentino", "#GamerPeruano", "#Uruguay", "#Humor", "#HumorArgentino", "#MomentosGraciosos"],
  virales_generales: ["#Shorts", "#Gaming", "#FYP", "#ParaTi", "#Viral", "#Funny", "#Clips", "#GamingClips"],
  combos: {
    shorts: "#Shorts #Overwatch #OverwatchClips #ClipsTwitch #StreamerLatino #Humor",
    instagram: "#Overwatch #OverwatchMemes #Reels #Gaming #TwitchLatam #HumorArgentino #ParaTi",
    tiktok: "#Overwatch #OverwatchFunny #fyp #parati #clipstwitch #streamerlatino #gaming",
  },
  fuentes: [],
};

export function getHashtags() {
  return readJson(FILE, null) || FALLBACK;
}

export async function refreshHashtags({ force = false } = {}) {
  const cur = readJson(FILE, null);
  const today = new Date().toISOString().slice(0, 10);
  if (!force && cur?.actualizado === today) return cur;
  if (!webSearchAvailable()) return cur || FALLBACK;
  const data = await researchHashtags(today);
  data.actualizado = today;
  const norm = (arr) => [...new Set((arr || []).map((h) => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).filter((h) => h.length > 1))];
  data.overwatch = norm(data.overwatch);
  data.latam_stream = norm(data.latam_stream);
  data.virales_generales = norm(data.virales_generales);
  writeJson(FILE, data);
  return data;
}

/** Mezcla hashtags del clip + tendencia, sin repetir, máximo n. */
export function pickHashtags(clipTags = [], platform = "shorts", n = 12) {
  const h = getHashtags();
  const combo = (h.combos?.[platform] || "").split(/\s+/).filter(Boolean);
  const all = [...combo, ...clipTags.map((t) => "#" + String(t).replace(/^#+/, "").replace(/\s+/g, "")), ...h.overwatch.slice(0, 4), ...h.latam_stream.slice(0, 4), ...h.virales_generales.slice(0, 2)];
  const seen = new Set();
  return all.filter((t) => { const k = t.toLowerCase(); if (t.length < 2 || seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
}
