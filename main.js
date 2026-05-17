// TCM Grid Builder — main.js
// Deploy on Deno Deploy, entrypoint: main.js
// ─────────────────────────────────────────────────────────────────────────────
// Fetches 4-day convective forecast at 3-hourly resolution for UK or EU.
// Primary: Met Office DataHub (UK only, requires MET_OFFICE_TCM_KEY env var)
// Fallback: Open-Meteo 6-model ensemble mean (free, no auth needed)
// Cache: Deno KV (persists across cold starts, 6h TTL)
//
// POST /  { region: 'uk' | 'eu', force?: true }
// → { ok, cached, builtAt, region, run, source, grid, summary }

const CACHE_TTL_MS       = 6 * 60 * 60 * 1000;
const POINT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HOURS_PER_STEP     = 3;
const STEPS_PER_DAY      = 8;
const TOTAL_STEPS        = 32;

// ─── In-memory per-point cache (survives warm requests) ──────────────────────
const POINT_CACHE = globalThis.__TCM_POINT_CACHE__ || (globalThis.__TCM_POINT_CACHE__ = new Map());
function pointCacheGet(region, lat, lon) {
  const e = POINT_CACHE.get(`${region}:${lat}_${lon}`);
  if (e && e.expiresAt > Date.now()) return e.data;
  return null;
}
function pointCacheSet(region, lat, lon, data) {
  POINT_CACHE.set(`${region}:${lat}_${lon}`, { data, expiresAt: Date.now() + POINT_CACHE_TTL_MS });
}

// ─── Grid geometry ────────────────────────────────────────────────────────────
const REGIONS = {
  uk: { bbox: { lonMin: -11.0, lonMax: 2.5,  latMin: 49.5, latMax: 61.0 }, step: 0.85 },
  eu: { bbox: { lonMin: -12.0, lonMax: 32.0, latMin: 35.0, latMax: 62.0 }, step: 1.50 },
};

function buildGrid(region) {
  const r = REGIONS[region];
  if (!r) return [];
  const pts = [];
  for (let lat = r.bbox.latMin; lat <= r.bbox.latMax + 0.001; lat += r.step)
    for (let lon = r.bbox.lonMin; lon <= r.bbox.lonMax + 0.001; lon += r.step)
      pts.push({ lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
  return pts;
}

// ─── WMO helpers ─────────────────────────────────────────────────────────────
function wmoIsThunderstorm(code) { return code != null && code >= 95; }
function wmoHasHail(code)        { return code === 96 || code === 99; }

// ─── Per-step metric builder ──────────────────────────────────────────────────
function buildPerStep(d) {
  const hourly  = d?.hourly || {};
  const cape    = hourly.cape                    || [];
  const cin     = hourly.convective_inhibition   || [];
  const t2      = hourly.temperature_2m          || [];
  const tSpread = hourly.temperature_2m_spread   || [];
  const twb     = hourly.wet_bulb_temperature_2m || [];
  const rain    = hourly.rain                    || [];
  const wcode   = hourly.weather_code            || [];
  const gust10  = hourly.wind_gusts_10m          || [];
  const wind10  = hourly.wind_speed_10m          || [];

  function dewPointAt(i) {
    const tv = t2[i]; const tw = twb[i];
    if (tv == null || tw == null) return null;
    return tv - (tv - tw) / 0.66;
  }
  function freezingLevelAt(i) {
    const tw = twb[i];
    if (tw == null || tw <= 0) return 2500;
    return Math.round((tw / 6.5) * 1000);
  }
  function shearProxyAt(capeVal, cinVal) {
    if (capeVal <= 0) return 0;
    const cinFactor = Math.max(0.2, 1 - cinVal / 100);
    return Math.min(30, (capeVal / 1500) * 25 * cinFactor);
  }

  const perStep = [];
  for (let s = 0; s < TOTAL_STEPS; s++) {
    const h0 = s * HOURS_PER_STEP;
    let cMax = 0, cinMax = 0, rainMax = 0, gMax = 0, wMax = 0;
    let tSum = 0, twSum = 0, tsSum = 0, n = 0;
    let peakWcode = 0;

    for (let h = h0; h < h0 + HOURS_PER_STEP; h++) {
      const cv = cape[h];   if (cv   != null && cv   > cMax)    cMax    = cv;
      const iv = cin[h];    if (iv   != null && Math.abs(iv) > cinMax) cinMax = Math.abs(iv);
      const rv = rain[h];   if (rv   != null && rv   > rainMax) rainMax = rv;
      const gv = gust10[h]; if (gv   != null && gv   > gMax)    gMax    = gv;
      const wv = wind10[h]; if (wv   != null && wv   > wMax)    wMax    = wv;
      const wc = wcode[h];  if (wc   != null && wc   > peakWcode) peakWcode = wc;
      if (t2[h]      != null) { tSum  += t2[h];      n++; }
      if (twb[h]     != null)   twSum += twb[h];
      if (tSpread[h] != null)   tsSum += tSpread[h];
    }
    if (n === 0) n = 1;
    const t2Avg     = tSum  / n;
    const twbAvg    = twSum / n;
    const spreadAvg = tsSum / n;

    const td         = dewPointAt(h0) ?? (t2Avg - 4);
    const tdSpread   = Math.max(0.5, t2Avg - td);
    const fzLvl      = freezingLevelAt(h0);
    const shear06    = shearProxyAt(cMax, cinMax);
    const shear01    = shear06 * 0.45;
    const helicity01 = shear01 * 30 + 20;
    const spreadDamp = Math.max(0.5, 1 - (spreadAvg - 1.5) / 6);

    perStep.push({
      metrics: {
        cape:       Math.round(cMax),
        li:         +(-(cMax / 200)).toFixed(1),
        cin:        Math.round(cinMax),
        td:         +td.toFixed(1),
        tdSpread:   +tdSpread.toFixed(1),
        fz:         Math.round(fzLvl),
        precip:     +rainMax.toFixed(1),
        gust:       Math.round(gMax * 0.621371),
        wind:       Math.round(wMax * 0.621371),
        shear:      +shear06.toFixed(1),
        shear01:    +shear01.toFixed(1),
        helicity01: Math.round(helicity01),
        tempSpread: +spreadAvg.toFixed(2),
        wetBulb:    +twbAvg.toFixed(1),
        wmoCode:    peakWcode,
        wmoTs:      wmoIsThunderstorm(peakWcode),
      },
      scores: engineScores({
        cape: cMax, shear: shear06, li: -(cMax / 200), cin: cinMax,
        td, tdSpread, fzLvl, precip: rainMax,
        gust: gMax * 0.621371, wind: wMax * 0.621371,
        helicity01, shear01,
        wmoCode: peakWcode,
        spreadDamp,
      }),
    });
  }
  return perStep;
}

// ─── Scoring engine ───────────────────────────────────────────────────────────
function engineScores({ cape, shear, li, cin, td, tdSpread, fzLvl, precip, gust, wind,
                         helicity01, shear01, wmoCode = 0, spreadDamp = 1 }) {
  const trigger     = Math.max(0, 1 - cin / 80);
  const moistFactor = Math.max(0, td - 4) / 14;
  const capeTerm    = Math.min(1, cape / 2200);
  const wmoBoost    = wmoIsThunderstorm(wmoCode) ? 1.25 : 1.0;

  let ts = 0;
  if (cape > 80 && tdSpread < 10) {
    const shearMod  = 0.7 + Math.min(0.5, shear / 50);
    const capeBoost = Math.min(1, cape / 1500);
    ts = 100 * Math.max(capeTerm, capeBoost * 0.45)
             * Math.min(1, moistFactor * 1.4)
             * Math.max(0.3, trigger)
             * shearMod * wmoBoost;
  }
  if (ts < 8 && li < 0 && cape > 50)
    ts = Math.max(ts, Math.min(25, Math.abs(li) * 5 + cape / 80));
  ts = Math.max(0, Math.min(100, ts * spreadDamp));

  const wmoHailBoost = wmoHasHail(wmoCode) ? 1.4 : 1.0;
  let hail = 0;
  if (ts > 25 && fzLvl < 4200) {
    const c = Math.min(1, Math.max(0, cape - 800) / 1800);
    const f = Math.max(0, (4200 - fzLvl) / 1800);
    const s = Math.min(1, shear / 25);
    hail = 100 * c * f * s * wmoHailBoost;
  }
  hail = Math.max(0, Math.min(100, hail));

  let tor = 0;
  if (ts > 35 && tdSpread < 4 && shear01 > 6) {
    const lcl = Math.max(0, (4 - tdSpread) / 4);
    const s01 = Math.min(1, (shear01 - 6) / 10);
    const hel = Math.min(1, helicity01 / 250);
    tor = 100 * lcl * s01 * hel * capeTerm * 0.85;
  }
  tor = Math.max(0, Math.min(100, tor));

  let ltg = 0;
  if (ts > 15) {
    const ice = Math.min(1, Math.max(0, 4500 - fzLvl) / 3000);
    ltg = ts * (0.7 + 0.3 * ice);
    if (wmoIsThunderstorm(wmoCode)) ltg = Math.min(100, ltg * 1.1);
  }
  ltg = Math.max(0, Math.min(100, ltg));

  const slowSteer   = Math.max(0, 1 - shear / 30);
  const flashFlood  = Math.min(100, Math.max(0, (precip - 4) * 9 * (0.5 + 0.6 * slowSteer)));
  const strongWinds = Math.min(100, Math.max(0, (gust - 25) * 2 + (tdSpread > 6 ? capeTerm * 45 : 0)));
  let supercell = 0;
  if (shear > 18 && cape > 1000)
    supercell = Math.min(100, ((shear - 18) / 18) * 50 + (cape - 1000) / 25 + helicity01 / 10);

  const hailMm     = hail > 5 ? Math.round(Math.min(70, Math.pow(cape / 200, 0.5) * Math.min(1, shear / 20) * 12)) : 0;
  const torroScale = tor < 5 ? 0 : tor < 15 ? 1 : tor < 30 ? 2 : tor < 50 ? 3 : 4;

  return {
    thunderstorm: Math.round(ts),
    hail:         Math.round(hail),
    tornado:      Math.round(tor),
    lightning:    Math.round(ltg),
    sub: {
      tornado:     Math.round(tor),
      hail:        Math.round(hail),
      flashFlood:  Math.round(flashFlood),
      strongWinds: Math.round(strongWinds),
      supercell:   Math.round(supercell),
    },
    hailMm,
    torro: torroScale,
  };
}

// ─── Met Office DataHub (UK primary) ─────────────────────────────────────────
async function fetchMetOfficePoint(lat, lon, apiKey) {
  const url = `https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point/hourly?latitude=${lat}&longitude=${lon}&excludeParameterMetadata=true&includeLocationName=false`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { apikey: apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`MO ${res.status}`);
  const data = await res.json();
  const ts = data?.features?.[0]?.properties?.timeSeries || [];
  if (!ts.length) throw new Error('MO empty timeSeries');

  const N = Math.min(96, ts.length);
  const hourly = {
    cape:                    new Array(N).fill(null),
    convective_inhibition:   new Array(N).fill(null),
    temperature_2m:          new Array(N).fill(null),
    wet_bulb_temperature_2m: new Array(N).fill(null),
    temperature_2m_spread:   new Array(N).fill(0),
    rain:                    new Array(N).fill(null),
    weather_code:            new Array(N).fill(null),
    wind_gusts_10m:          new Array(N).fill(null),
    wind_speed_10m:          new Array(N).fill(null),
  };
  for (let i = 0; i < N; i++) {
    const t = ts[i] || {};
    hourly.temperature_2m[i]  = t.screenTemperature ?? null;
    const tdp = t.screenDewPointTemperature;
    if (t.screenTemperature != null && tdp != null)
      hourly.wet_bulb_temperature_2m[i] = t.screenTemperature - 0.66 * (t.screenTemperature - tdp);
    hourly.wind_gusts_10m[i] = t.windGustSpeed10m != null ? t.windGustSpeed10m * 3.6 : null;
    hourly.wind_speed_10m[i] = t.windSpeed10m     != null ? t.windSpeed10m * 3.6     : null;
    hourly.rain[i]            = t.totalPrecipAmount ?? t.totalSnowAmount ?? 0;
    const swc = t.significantWeatherCode ?? -1;
    hourly.weather_code[i]    = swc >= 29 ? 95 : swc >= 27 ? 80 : 0;
  }
  return { hourly };
}

async function fetchMetOfficeBatch(points, apiKey) {
  const out = {};
  const CONC = 6;
  let idx = 0, failures = 0;
  async function worker() {
    while (idx < points.length) {
      const myIdx = idx++;
      const pt = points[myIdx];
      try {
        out[`${pt.lat}_${pt.lon}`] = await fetchMetOfficePoint(pt.lat, pt.lon, apiKey);
      } catch (e) {
        failures++;
        if (failures <= 3) console.warn(`[tcmGrid] MO ${pt.lat},${pt.lon}`, e.message);
        if (failures > 10) return;
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return out;
}

// ─── Open-Meteo 6-model ensemble (fallback / EU primary) ─────────────────────
async function fetchOMEnsembleBatch(points, region) {
  const out = {};
  const BATCH = 30;

  const MODELS_UK = [
    'dwd_icon_eu_eps_ensemble_mean',
    'meteoswiss_icon_ch1_ensemble_mean',
    'ncep_gefs025_ensemble_mean',
    'ecmwf_ifs025_ensemble_mean',
    'ukmo_global_ensemble_mean_20km',
    'ukmo_uk_ensemble_mean_2km',
  ].join(',');
  const MODELS_EU = [
    'dwd_icon_eu_eps_ensemble_mean',
    'meteoswiss_icon_ch1_ensemble_mean',
    'ncep_gefs025_ensemble_mean',
    'ecmwf_ifs025_ensemble_mean',
    'ukmo_global_ensemble_mean_20km',
  ].join(',');

  const MODELS = region === 'uk' ? MODELS_UK : MODELS_EU;
  const HOURLY = [
    'temperature_2m', 'temperature_2m_spread', 'wet_bulb_temperature_2m',
    'rain', 'weather_code', 'cape', 'convective_inhibition',
    'wind_gusts_10m', 'wind_speed_10m',
  ].join(',');

  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    const lats  = batch.map(p => p.lat).join(',');
    const lons  = batch.map(p => p.lon).join(',');
    const url   =
      `https://ensemble-api.open-meteo.com/v1/ensemble` +
      `?latitude=${lats}&longitude=${lons}` +
      `&hourly=${HOURLY}&models=${MODELS}&timezone=UTC&forecast_days=4`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) { console.warn('[tcmGrid] OM ensemble batch', res.status); continue; }
      const data = await res.json();
      const arr  = Array.isArray(data) ? data : [data];
      arr.forEach((d, idx) => {
        const pt = batch[idx];
        if (!pt || !d?.hourly) return;
        out[`${pt.lat}_${pt.lon}`] = d;
      });
    } catch (e) {
      console.warn('[tcmGrid] OM ensemble batch err', e.message);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function p95(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; }
function p05(arr) { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.05)]; }

function buildSummary(grid) {
  return [0, 1, 2, 3].map(d => {
    const ts=[], hl=[], tn=[], lg=[], subT=[], subH=[], subF=[], subW=[], subS=[];
    const capes=[], shears=[], gusts=[], precs=[], winds=[], hails=[], torros=[], spreads=[];
    let stormy = 0;
    for (const p of grid) {
      const slice = p.perStep.slice(d * STEPS_PER_DAY, (d + 1) * STEPS_PER_DAY);
      let peakTs=0, peakHl=0, peakTn=0, peakLg=0;
      let peakSubT=0, peakSubH=0, peakSubF=0, peakSubW=0, peakSubS=0;
      let peakCape=0, peakShear=0, peakGust=0, peakPrec=0, peakWind=0, peakHailMm=0, peakTorro=0, maxSpread=0;
      for (const st of slice) {
        if (st.scores.thunderstorm      > peakTs)   peakTs   = st.scores.thunderstorm;
        if (st.scores.hail              > peakHl)   peakHl   = st.scores.hail;
        if (st.scores.tornado           > peakTn)   peakTn   = st.scores.tornado;
        if (st.scores.lightning         > peakLg)   peakLg   = st.scores.lightning;
        if (st.scores.sub.tornado       > peakSubT) peakSubT = st.scores.sub.tornado;
        if (st.scores.sub.hail          > peakSubH) peakSubH = st.scores.sub.hail;
        if (st.scores.sub.flashFlood    > peakSubF) peakSubF = st.scores.sub.flashFlood;
        if (st.scores.sub.strongWinds   > peakSubW) peakSubW = st.scores.sub.strongWinds;
        if (st.scores.sub.supercell     > peakSubS) peakSubS = st.scores.sub.supercell;
        if (st.metrics.cape             > peakCape)   peakCape   = st.metrics.cape;
        if (st.metrics.shear            > peakShear)  peakShear  = st.metrics.shear;
        if (st.metrics.gust             > peakGust)   peakGust   = st.metrics.gust;
        if (st.metrics.precip           > peakPrec)   peakPrec   = st.metrics.precip;
        if (st.metrics.wind             > peakWind)   peakWind   = st.metrics.wind;
        if (st.scores.hailMm            > peakHailMm) peakHailMm = st.scores.hailMm;
        if (st.scores.torro             > peakTorro)  peakTorro  = st.scores.torro;
        if ((st.metrics.tempSpread||0)  > maxSpread)  maxSpread  = st.metrics.tempSpread || 0;
      }
      ts.push(peakTs); hl.push(peakHl); tn.push(peakTn); lg.push(peakLg);
      spreads.push(maxSpread);
      if (peakTs >= 10) {
        stormy++;
        subT.push(peakSubT); subH.push(peakSubH); subF.push(peakSubF);
        subW.push(peakSubW); subS.push(peakSubS);
        capes.push(peakCape); shears.push(peakShear); gusts.push(peakGust);
        precs.push(peakPrec); winds.push(peakWind); hails.push(peakHailMm); torros.push(peakTorro);
      }
      p.perDay = p.perDay || [];
      p.perDay[d] = { scores: {
        thunderstorm: peakTs, hail: peakHl, tornado: peakTn, lightning: peakLg,
        sub: { tornado: peakSubT, hail: peakSubH, flashFlood: peakSubF, strongWinds: peakSubW, supercell: peakSubS },
        hailMm: peakHailMm, torro: peakTorro,
        metrics: { cape: peakCape, shear: peakShear, gust: peakGust, precip: peakPrec, wind: peakWind },
      }};
    }
    return {
      thunderstorm: p95(ts), hail: p95(hl), tornado: p95(tn), lightning: p95(lg),
      stormyCells: stormy, totalCells: grid.length,
      sub: { tornado: p95(subT), hail: p95(subH), flashFlood: p95(subF), strongWinds: p95(subW), supercell: p95(subS) },
      ranges: {
        cape:       { min: p05(capes),   max: p95(capes)   },
        shear:      { min: p05(shears),  max: p95(shears)  },
        gust:       { min: p05(gusts),   max: p95(gusts)   },
        precip:     { min: p05(precs),   max: p95(precs)   },
        wind:       { min: p05(winds),   max: p95(winds)   },
        hailMm:     { min: 0,            max: p95(hails)   },
        torro:      { min: 0,            max: Math.max(0, ...torros) },
        tempSpread: { min: p05(spreads), max: p95(spreads) },
      },
    };
  });
}

// ─── CORS headers (required so Base44 frontend can call this) ─────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Main handler ─────────────────────────────────────────────────────────────
const kv = await Deno.openKv();

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const t0 = Date.now();
  try {
    let body = {};
    try { body = await req.json(); } catch (_) {}

    const region   = body.region === 'eu' ? 'eu' : 'uk';
    const force    = !!body.force;
    const cacheKey = ['grid', region, 'v3'];

    // ── Deno KV cache check ──────────────────────────────────────────────────
    if (!force) {
      const cached = await kv.get(cacheKey);
      if (cached.value && cached.value.expiresAt > Date.now()) {
        return Response.json(
          { ok: true, cached: true, ...cached.value.data },
          { headers: CORS }
        );
      }
    }

    // ── Build grid ───────────────────────────────────────────────────────────
    const pts = buildGrid(region);
    console.log(`[tcmGrid] ${region}: ${pts.length} points`);

    const moData = {}, omData = {};
    const needFetch = [];
    let pointCacheHits = 0;

    for (const pt of pts) {
      const cached = pointCacheGet(region, pt.lat, pt.lon);
      if (cached) {
        if (cached._src === 'mo') moData[`${pt.lat}_${pt.lon}`] = cached.data;
        else                      omData[`${pt.lat}_${pt.lon}`] = cached.data;
        pointCacheHits++;
      } else {
        needFetch.push(pt);
      }
    }
    console.log(`[tcmGrid] point-cache hits: ${pointCacheHits}/${pts.length}, fetching ${needFetch.length}`);

    // Primary: Met Office (UK only)
    const moKey = Deno.env.get('MET_OFFICE_TCM_KEY') || '';
    if (moKey && region === 'uk' && needFetch.length) {
      try {
        const moFresh = await fetchMetOfficeBatch(needFetch, moKey);
        for (const [k, v] of Object.entries(moFresh)) {
          moData[k] = v;
          const [lat, lon] = k.split('_').map(Number);
          pointCacheSet(region, lat, lon, { _src: 'mo', data: v });
        }
        console.log(`[tcmGrid] MO hits: ${Object.keys(moFresh).length}/${needFetch.length}`);
      } catch (e) { console.warn('[tcmGrid] MO batch failed', e.message); }
    }

    // Fallback / EU primary: Open-Meteo ensemble
    const stillMissing = needFetch.filter(p => !moData[`${p.lat}_${p.lon}`]);
    if (stillMissing.length) {
      const omFresh = await fetchOMEnsembleBatch(stillMissing, region);
      for (const [k, v] of Object.entries(omFresh)) {
        omData[k] = v;
        const [lat, lon] = k.split('_').map(Number);
        pointCacheSet(region, lat, lon, { _src: 'om', data: v });
      }
      console.log(`[tcmGrid] OM ensemble hits: ${Object.keys(omFresh).length}/${stillMissing.length}`);
    }

    // ── Assemble grid ────────────────────────────────────────────────────────
    const grid = [];
    let usedMO = 0, usedOM = 0;
    for (const pt of pts) {
      const key = `${pt.lat}_${pt.lon}`;
      const d   = moData[key] || omData[key];
      if (!d) continue;
      if (moData[key]) usedMO++; else usedOM++;
      grid.push({ lat: pt.lat, lon: pt.lon, perStep: buildPerStep(d) });
    }
    console.log(`[tcmGrid] grid: ${grid.length}/${pts.length} (MO ${usedMO}, OM ${usedOM})`);

    const summary = buildSummary(grid);
    // Strip perDay temp data from grid cells before sending
    for (const p of grid) delete p.perDay;

    const run         = new Date().toISOString();
    const source      = usedMO && usedOM
      ? 'Met Office (primary) + Open-Meteo 6-model ensemble mean (fallback)'
      : usedMO
        ? 'Met Office DataHub'
        : 'Open-Meteo 6-model ensemble mean (DWD · MeteoSwiss · NCEP · ECMWF · UKMO)';

    const payload = { ok: true, cached: false, builtAt: Date.now(), region, run, source, grid, summary };

    // ── Save to Deno KV ──────────────────────────────────────────────────────
    await kv.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, data: payload });

    return Response.json(payload, { headers: CORS });

  } catch (e) {
    console.error('[tcmGrid] error', e);
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: CORS });
  }
});
