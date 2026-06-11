/* ============================================================================
   Wet Pockets — "flying rivers" moisture streamlines
   ----------------------------------------------------------------------------
   Reads as coherent rivers of moisture, not a field of ticks:

   • Each stream keeps a TRAIL (a short polyline history) and is drawn as one
     tapered, fading line — so it looks like flowing water, with a bright head
     and a dissolving tail.
   • Everything is CONFINED TO THE BASIN. Streams enter from the Atlantic side
     (the eastern basin, near the Amazon's mouth), sweep WEST across the basin,
     and recurve SOUTH against the Andes (the South American Low-Level Jet).
     The whole layer is clipped to the basin so nothing scatters over the ocean.
   • Each stream carries a live MOISTURE budget tied to the interpolated rainfall
     surface: it bleeds over rainfall deficits (dry pockets) and cleared, low-
     forest land, and recharges over wet, intact canopy. So the rivers visibly
     THIN and PALE over the pockets you detect, and respond to season / drying /
     interpolation settings.

   Illustrative climatology — not a reanalysis wind product.
   ============================================================================ */
(function () {
  const WP = (window.WP = window.WP || {});
  const B = WP.BOUNDS;

  const N = 150;            // number of streams
  const TRAIL = 22;         // trail history length (points)
  const STEP = 1.0;         // advection step scale
  const streams = [];
  let seeds = [];           // basin-interior spawn points
  let eastSeeds = [];       // eastern-basin inflow points

  // Precompute basin-interior seed points (so streams never start over ocean).
  function buildSeeds() {
    seeds = []; eastSeeds = [];
    for (let lat = B.latMin + 1; lat <= B.latMax - 1; lat += 0.6) {
      for (let lon = B.lonMin + 1; lon <= B.lonMax - 1; lon += 0.6) {
        if (WP.inBasin(lon, lat)) {
          seeds.push([lon, lat]);
          if (lon > -55) eastSeeds.push([lon, lat]); // eastern half = Atlantic inflow
        }
      }
    }
    if (!eastSeeds.length) eastSeeds = seeds.slice();
  }

  function respawn(s, initial) {
    const pool = initial ? seeds : (Math.random() < 0.7 ? eastSeeds : seeds);
    const seed = pool[(Math.random() * pool.length) | 0] || [-55, -4];
    s.lon = seed[0] + (Math.random() - 0.5) * 0.5;
    s.lat = seed[1] + (Math.random() - 0.5) * 0.5;
    s.trail = [[s.lon, s.lat]];
    s.moist = 0.78 + Math.random() * 0.22;   // arrives moist from the Atlantic
    s.age = 0;
    s.maxAge = 120 + (Math.random() * 120) | 0;
    s.speed = 0.85 + Math.random() * 0.4;
  }

  WP.flowInit = function () {
    buildSeeds();
    streams.length = 0;
    for (let i = 0; i < N; i++) { const s = {}; respawn(s, true); streams.push(s); }
  };

  // ---- moisture-flux DIRECTION field (deg per step) --------------------
  // Easterly base → westward; equatorial intensification; gentle poleward turn
  // inland; strong southward recurve against the Andes wall (SALLJ).
  function flow(lon, lat) {
    let u = -0.085;                                    // base westward (easterlies)
    let v = 0;
    const eqp = Math.exp(-((lat + 2) * (lat + 2)) / (2 * 9 * 9));
    u -= 0.045 * eqp;                                  // faster in equatorial belt
    const wf = (B.lonMax - lon) / (B.lonMax - B.lonMin); // 0 east → 1 west
    v -= 0.030 * wf;                                   // turn south moving inland
    if (lon < -68) {                                   // Andes wall: zonal flow stalls,
      const d = -68 - lon;                             // recurves into the southward jet
      u *= Math.max(0.25, 1 - d * 0.10);
      v -= 0.030 * d;
    }
    v += 0.018 * Math.sin(lon * 0.45 + lat * 0.5);     // organic meander
    return [u, v];
  }
  WP.flowVector = flow;

  function sampleRain(interp, lon, lat) {
    if (!interp || !interp.grid) return NaN;
    const gx = Math.floor(((lon - B.lonMin) / (B.lonMax - B.lonMin)) * interp.gw);
    const gy = Math.floor(((B.latMax - lat) / (B.latMax - B.latMin)) * interp.gh);
    if (gx < 0 || gy < 0 || gx >= interp.gw || gy >= interp.gh) return NaN;
    return interp.grid[gy * interp.gw + gx];
  }

  // ---- advance streams; moisture budget driven by the LIVE surface -----
  WP.flowStep = function (interp) {
    if (!seeds.length) buildSeeds();
    const mean = interp && interp.basinMean ? interp.basinMean : 0;
    for (const s of streams) {
      const [u, v] = flow(s.lon, s.lat);
      s.lon += u * STEP * s.speed;
      s.lat += v * STEP * s.speed;
      s.age++;
      // moisture update from the live surface
      const inB = WP.inBasin(s.lon, s.lat);
      if (inB) {
        const f = WP.forestAt(s.lon, s.lat);
        const rain = sampleRain(interp, s.lon, s.lat);
        const anom = mean > 0 && !isNaN(rain) ? (rain - mean) / mean : 0;
        const recharge = Math.max(0, anom) * 0.045 * Math.max(0, f - 0.4);
        const drain = Math.max(0, -anom) * 0.11 + (1 - f) * 0.040;
        s.moist += recharge - drain;
      }
      s.moist = Math.max(0, Math.min(1, s.moist));
      // extend trail
      s.trail.push([s.lon, s.lat]);
      if (s.trail.length > TRAIL) s.trail.shift();
      // respawn when it leaves the basin (west/Andes/edge), dries out, or ages
      if (!inB || s.moist <= 0.04 || s.age > s.maxAge ||
          s.lon < B.lonMin + 0.5 || s.lat < B.latMin + 0.5 || s.lat > B.latMax - 0.5) {
        respawn(s, false);
      }
    }
  };

  WP.renderFlow = function (canvas, opts) {
    const ctx = canvas.getContext("2d");
    const proj = WP.proj, dpr = opts.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // clip to the basin so streams never show over the ocean / outside
    ctx.save();
    if (WP.BASIN) { WP.pathFrom(WP.BASIN, ctx); ctx.closePath(); ctx.clip(); }
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    for (const s of streams) {
      const t = s.trail;
      if (!t || t.length < 2) continue;
      const m = s.moist;
      // age fade-in / fade-out so spawns/despawns aren't abrupt
      const ageA = Math.min(1, s.age / 10) * Math.min(1, (s.maxAge - s.age) / 16);
      // colour: moist = blue, drained = pale ochre
      const r = 60 + (1 - m) * 140, g = 150 - (1 - m) * 22, b = 206 - (1 - m) * 140;
      // draw trail as tapered, fading segments (tail → head)
      for (let i = 1; i < t.length; i++) {
        const f0 = i / t.length;                 // 0 tail .. 1 head
        const x0 = proj.x(t[i - 1][0]), y0 = proj.y(t[i - 1][1]);
        const x1 = proj.x(t[i][0]), y1 = proj.y(t[i][1]);
        const a = 0.5 * ageA * (0.15 + 0.85 * f0) * (0.35 + 0.65 * m);
        ctx.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
        ctx.lineWidth = (0.4 + 2.0 * m) * (0.4 + 0.6 * f0);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      // bright head dot
      const hx = proj.x(t[t.length - 1][0]), hy = proj.y(t[t.length - 1][1]);
      ctx.beginPath();
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${0.7 * ageA * (0.4 + 0.6 * m)})`;
      ctx.arc(hx, hy, 0.5 + 1.4 * m, 0, 7); ctx.fill();
    }
    ctx.restore();
  };

})();
