/* ============================================================================
   Wet Pockets — analysis features
     • confidenceGrid : interpolation confidence from gauge proximity/density
     • idwLOO / krigeLOO : leave-one-out cross-validation RMSE (skill score)
     • sampleTransect : profile of rainfall/forest/temp along a line
     • TOUR : guided-tour steps
   ============================================================================ */
(function () {
  const WP = (window.WP = window.WP || {});
  const B = WP.BOUNDS;

  // ---- interpolation confidence -----------------------------------------
  // For each cell: how well-constrained is the interpolation here? Driven by
  // distance to the nearest gauge AND how many gauges sit within the search
  // radius (more nearby gauges = more confident). 0 (guess) … 1 (well sampled).
  WP.confidenceGrid = function (gw, gh, radiusDeg) {
    const st = WP.STATIONS, n = st.length;
    const grid = new Float32Array(gw * gh);
    const scale = 3.2; // degrees; nearest-gauge falloff
    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        let nearest = Infinity, density = 0;
        for (let i = 0; i < n; i++) {
          const dx = lon - st[i].lon, dy = lat - st[i].lat;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < nearest) nearest = d;
          if (d < radiusDeg) density += 1 - d / radiusDeg;
        }
        const prox = Math.exp(-nearest / scale);           // close gauge ⇒ high
        const dens = 1 - Math.exp(-density / 2.2);          // several nearby ⇒ high
        grid[gy * gw + gx] = Math.max(0, Math.min(1, 0.55 * prox + 0.45 * dens));
      }
    }
    return grid;
  };

  // ---- leave-one-out cross-validation ----------------------------------
  // Hide each gauge, predict it from the rest with the CURRENT method/params,
  // and report RMSE + mean-absolute error (mm) for the current month.
  function idwPredict(lon, lat, month, power, radiusDeg, skip) {
    const st = WP.STATIONS, r2 = radiusDeg * radiusDeg;
    let num = 0, den = 0;
    for (let i = 0; i < st.length; i++) {
      if (i === skip) continue;
      const dx = lon - st[i].lon, dy = lat - st[i].lat, d2 = dx * dx + dy * dy;
      if (d2 > r2 || d2 < 1e-9) continue;
      const w = 1 / Math.pow(d2, power / 2);
      num += w * st[i].monthly[month]; den += w;
    }
    return den > 0 ? num / den : NaN;
  }

  WP.looCV = function (opts) {
    const st = WP.STATIONS, month = opts.month;
    let se = 0, ae = 0, n = 0;
    if (opts.method === "krige") {
      // OK leave-one-out via the inverse-matrix identity:
      //   ẑ_(-i)(x_i) − z_i = − ( Σ_j A⁻¹_ij z_j ) / A⁻¹_ii      (Lagrange row excluded)
      const k = WP.krigeSystem(opts.range, opts.nugget, month, opts.trend); // {Ainv, z, m, n}
      if (k) {
        const { Ainv, z, m } = k;
        for (let i = 0; i < st.length; i++) {
          let s = 0;
          for (let j = 0; j < st.length; j++) s += Ainv[i][j] * z[j];
          const err = s / Ainv[i][i];           // = ẑ_(-i) − z_i
          se += err * err; ae += Math.abs(err); n++;
        }
      }
    } else {
      for (let i = 0; i < st.length; i++) {
        const pred = idwPredict(st[i].lon, st[i].lat, month, opts.power, opts.radiusDeg, i);
        if (isNaN(pred)) continue;
        const err = pred - st[i].monthly[month];
        se += err * err; ae += Math.abs(err); n++;
      }
    }
    return n ? { rmse: Math.sqrt(se / n), mae: ae / n, n } : { rmse: NaN, mae: NaN, n: 0 };
  };

  // ---- transect profile -------------------------------------------------
  // Sample rainfall (interpolated surface), forest, temp along A→B.
  WP.sampleTransect = function (a, b, interp, steps) {
    steps = steps || 80;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lon = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      let rain = NaN;
      if (interp && interp.grid) {
        const gx = Math.floor(((lon - B.lonMin) / (B.lonMax - B.lonMin)) * interp.gw);
        const gy = Math.floor(((B.latMax - lat) / (B.latMax - B.latMin)) * interp.gh);
        if (gx >= 0 && gy >= 0 && gx < interp.gw && gy < interp.gh) rain = interp.grid[gy * interp.gw + gx];
      }
      out.push({ t, lon, lat, rain, forest: WP.forestAt(lon, lat), temp: WP.tempAt(lon, lat), inBasin: WP.inBasin(lon, lat) });
    }
    return out;
  };

  // ---- guided tour ------------------------------------------------------
  WP.TOUR = [
    { title: "The forest makes its own rain",
      body: "The Amazon recycles moisture from the Atlantic westward — the “flying rivers.” We watch that system through ~57 real rain gauges (ERA5). Sparse dots, a whole basin to cover.",
      state: { base: "rainfall", month: 2, flow: true, pockets: false, compare: false } },
    { title: "Interpolation fills the gaps",
      body: "Inverse-distance weighting turns the scattered gauges into a continuous surface. Drag Power & Radius — the picture is a choice, not a fact.",
      state: { base: "rainfall", month: 2, pockets: false } },
    { title: "How much can we trust it?",
      body: "The confidence layer shows where the surface is well-sampled (green) versus a guess between distant gauges (red). The gauge-sparse east is the least certain.",
      state: { base: "conf", pockets: false } },
    { title: "The dry season opens pockets",
      body: "Run to August. Rainfall collapses across the south and east, and dry pockets bloom along the arc of deforestation — low rain, low canopy, hot surface.",
      state: { base: "rainfall", month: 7, pockets: true, flow: true } },
    { title: "Where to act",
      body: "The priority panel ranks sub-regions by composite risk. Reforestation corridors, protected-area reinforcement, and — where interpolation is weakest — new monitoring.",
      state: { base: "rainfall", month: 7, pockets: true } },
  ];

})();
