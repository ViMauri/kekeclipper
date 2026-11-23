// Cola simple de trabajos en segundo plano con progreso (la UI hace polling).
import crypto from "node:crypto";

const jobs = new Map();

export function startJob(type, meta, fn) {
  const id = crypto.randomUUID().slice(0, 8);
  const job = { id, type, meta, status: "running", progress: 0, message: "Iniciando…", log: [], result: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  const ctx = {
    progress(p, msg) { if (p != null) job.progress = Math.max(0, Math.min(1, p)); if (msg) { job.message = msg; job.log.push(`${new Date().toLocaleTimeString()} ${msg}`); if (job.log.length > 200) job.log.shift(); } },
    log(msg) { job.log.push(`${new Date().toLocaleTimeString()} ${msg}`); console.log(`[${type}:${id}] ${msg}`); },
    get cancelled() { return job.status === "cancelled"; },
  };
  Promise.resolve()
    .then(() => fn(ctx))
    .then((r) => { if (job.status === "running") { job.status = "done"; job.progress = 1; job.result = r; job.message = "Listo"; } })
    .catch((e) => { console.error(e); job.status = "error"; job.error = e.message || String(e); job.message = "Error: " + job.error; });
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }
export function listJobs() { return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30); }
export function cancelJob(id) { const j = jobs.get(id); if (j && j.status === "running") { j.status = "cancelled"; j.message = "Cancelado"; } return j; }
export function runningJobFor(type, key) { return [...jobs.values()].find((j) => j.type === type && j.status === "running" && j.meta?.key === key) || null; }
