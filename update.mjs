// Atualiza o calendário (fixtures.json) a partir da API-Football. Corre no GitHub Actions.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyze, MODEL_VERSION } from "./model.ts";

// calendar:true = temporada = ano civil (Brasil, EUA). As restantes começam em agosto.
export const COMPETITIONS = [
  { id: 2, name: "UEFA Champions League", country: "Europa" },
  { id: 3, name: "UEFA Europa League", country: "Europa" },
  { id: 848, name: "UEFA Conference League", country: "Europa" },
  { id: 39, name: "Premier League", country: "Inglaterra" },
  { id: 40, name: "Championship", country: "Inglaterra" },
  { id: 140, name: "La Liga", country: "Espanha" },
  { id: 141, name: "La Liga 2", country: "Espanha" },
  { id: 78, name: "Bundesliga", country: "Alemanha" },
  { id: 79, name: "2. Bundesliga", country: "Alemanha" },
  { id: 135, name: "Serie A", country: "Itália" },
  { id: 136, name: "Serie B", country: "Itália" },
  { id: 88, name: "Eredivisie", country: "Países Baixos" },
  { id: 89, name: "Eerste Divisie", country: "Países Baixos" },
  { id: 94, name: "Primeira Liga", country: "Portugal" },
  { id: 71, name: "Brasileirão Série A", country: "Brasil", calendar: true },
  { id: 72, name: "Brasileirão Série B", country: "Brasil", calendar: true },
  { id: 307, name: "Liga Profissional Saudita", country: "Arábia Saudita" },
  { id: 253, name: "MLS", country: "Estados Unidos", calendar: true },
  { id: 255, name: "USL Championship", country: "Estados Unidos", calendar: true },
  { id: 61, name: "Ligue 1", country: "França" },
  { id: 62, name: "Ligue 2", country: "França" },
  { id: 203, name: "Süper Lig", country: "Turquia" },
  { id: 204, name: "1. Lig", country: "Turquia" },
  // Girabola (Angola): acrescenta { id: ID_CONFIRMADO, name: "Girabola", country: "Angola" } quando souberes o ID.
];
const BASE = "https://v3.football.api-sports.io";
const FINAL = new Set(["FT", "AET", "PEN"]);
const WINDOW_DAYS = 7, FORM_N = 12, H = 3600e3;

export const seasonFor = (c, now) => c.calendar ? now.getUTCFullYear() : (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

export function normalize(x, comp) {
  return {
    id: String(x.fixture.id), competition_id: comp.id,
    competitions: { name: comp.name, country: comp.country },
    home_team_id: x.teams.home.id, away_team_id: x.teams.away.id,
    home_team: x.teams.home.name, away_team: x.teams.away.name,
    home_logo: x.teams.home.logo ?? null, away_logo: x.teams.away.logo ?? null,
    kickoff_utc: new Date(x.fixture.date).toISOString(),
    time_confirmed: x.fixture.status.short !== "TBD",
    status: x.fixture.status.short,
    home_goals: x.goals.home, away_goals: x.goals.away,
  };
}

const TRACK = ["kickoff_utc", "time_confirmed", "status", "home_goals", "away_goals"];

// results: [{comp, ok, fixtures?: normalized[], error?}]
export function buildData({ prev, results, now = new Date(), windowDays = WINDOW_DAYS }) {
  const t = now.getTime(), start = t - 24 * H, end = t + windowDays * 86400e3;
  const prevById = new Map((prev?.matches ?? []).map((m) => [m.id, m]));
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.comp.id));

  // Forma recente por equipa (IDs de equipa são globais): só jogos terminados
  const form = new Map();
  for (const r of results) if (r.ok) for (const f of r.fixtures) {
    if (!FINAL.has(f.status) || f.home_goals == null || f.away_goals == null) continue;
    const d = Date.parse(f.kickoff_utc);
    (form.get(f.home_team_id) ?? form.set(f.home_team_id, []).get(f.home_team_id)).push({ d, gf: f.home_goals, ga: f.away_goals });
    (form.get(f.away_team_id) ?? form.set(f.away_team_id, []).get(f.away_team_id)).push({ d, gf: f.away_goals, ga: f.home_goals });
  }
  const last = (id) => (form.get(id) ?? []).sort((a, b) => b.d - a.d).slice(0, FORM_N).map(({ gf, ga }) => ({ gf, ga }));

  const matches = [], changes = [];
  const seen = new Set();
  for (const r of results) if (r.ok) for (const f of r.fixtures) {
    const k = Date.parse(f.kickoff_utc);
    if (!(k >= start && k <= end) || seen.has(f.id)) continue;
    seen.add(f.id);
    const old = prevById.get(f.id);
    if (old) for (const fld of TRACK) {
      const a = old[fld] ?? null, b = f[fld] ?? null;
      const same = a === b || (fld === "kickoff_utc" && Date.parse(a) === Date.parse(b));
      if (!same) changes.push({ id: f.id, match: `${f.home_team} vs ${f.away_team}`, field: fld, old: a, new: b, at: now.toISOString() });
    }
    let analysis = null, analysis_note = null;
    if (["NS", "TBD"].includes(f.status)) {
      const res = analyze({ home: last(f.home_team_id), away: last(f.away_team_id) });
      if (res.ok) analysis = { model_version: MODEL_VERSION, created_at: now.toISOString(), result: res };
      else analysis_note = res.reason;
    }
    matches.push({ ...f, analysis, analysis_note, updated_at: now.toISOString(), source: "api-football" });
  }
  // Ligas que falharam: mantém o que já estava guardado (nunca apaga por falha)
  for (const m of prev?.matches ?? []) {
    if (okIds.has(m.competition_id) || seen.has(m.id)) continue;
    if (Date.parse(m.kickoff_utc) >= start) matches.push({ ...m, stale: true });
  }
  matches.sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc));
  const anyOk = okIds.size > 0;
  return {
    generatedAt: now.toISOString(),
    lastSuccessAt: anyOk ? now.toISOString() : prev?.lastSuccessAt ?? null,
    windowDays,
    leagues: results.map((r) => ({ id: r.comp.id, name: r.comp.name, ok: r.ok, count: r.ok ? r.fixtures.filter((f) => seen.has(f.id)).length : 0, error: r.error ?? null })),
    matches,
    changes: [...(prev?.changes ?? []), ...changes].slice(-200),
  };
}

async function fetchLeague(comp, now, key, sleep) {
  const url = `${BASE}/fixtures?league=${comp.id}&season=${seasonFor(comp, now)}&timezone=UTC`;
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers: { "x-apisports-key": key } });
      if (r.status === 429) return { limit: true };
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const errs = j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length) ? JSON.stringify(j.errors) : null;
      if (errs) { if (errs.toLowerCase().includes("limit") || errs.toLowerCase().includes("request")) return { limit: true }; throw new Error(errs); }
      const remaining = Number(r.headers.get("x-ratelimit-requests-remaining") ?? NaN);
      return { fixtures: (j.response ?? []).map((x) => normalize(x, comp)), remaining };
    } catch (e) { lastErr = e; if (i < 3) await sleep(1000 * 2 ** (i - 1)); }
  }
  throw lastErr;
}

export async function main({ key = process.env.FOOTBALL_API_KEY, now = new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), file = "fixtures.json" } = {}) {
  if (!key) throw new Error("Falta o segredo FOOTBALL_API_KEY.");
  let prev = null;
  try { prev = JSON.parse(await readFile(file, "utf8")); } catch {}
  const results = []; let stop = false;
  for (const comp of COMPETITIONS) {
    if (stop) { results.push({ comp, ok: false, error: "ignorada: limite de pedidos da API" }); continue; }
    try {
      const r = await fetchLeague(comp, now, key, sleep);
      if (r.limit) { stop = true; results.push({ comp, ok: false, error: "limite de pedidos da API atingido" }); continue; }
      results.push({ comp, ok: true, fixtures: r.fixtures });
      if (!Number.isNaN(r.remaining) && r.remaining <= 2) stop = true;
    } catch (e) { results.push({ comp, ok: false, error: String(e.message ?? e) }); }
  }
  const data = buildData({ prev, results, now });
  await writeFile(file, JSON.stringify(data));
  const bad = data.leagues.filter((l) => !l.ok);
  console.log(`Jogos: ${data.matches.length} | ligas com erro: ${bad.length}`);
  bad.forEach((l) => console.log(` - ${l.name}: ${l.error}`));
  if (!results.some((r) => r.ok)) process.exitCode = 1; // nenhuma liga atualizada: falha visível no Actions
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
