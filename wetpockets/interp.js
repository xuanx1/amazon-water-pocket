/* ============================================================================
   Wet Pockets — projection + interpolation engine
   - Equirectangular projection (contain-fit into the viewport)
   - IDW (inverse-distance weighting) with adjustable power + search radius
   - Wet / dry pocket classification
   - Marching squares for pocket contour outlines
   ============================================================================ */
(function () {
  const WP = (window.WP = window.WP || {});
  const B = WP.BOUNDS;

  // -------------------- projection --------------------------------------
  const proj = (WP.proj = {
    w: 0, h: 0, scale: 1, ox: 0, oy: 0,
    set(w, h) {
      this.w = w; this.h = h;
      const sx = w / (B.lonMax - B.lonMin);
      const sy = h / (B.latMax - B.latMin);
      // contain-fit with a little breathing room
      const s = Math.min(sx, sy) * 0.98;
      this.scale = s;
      this.ox = (w - s * (B.lonMax - B.lonMin)) / 2;
      this.oy = (h - s * (B.latMax - B.latMin)) / 2;
    },
    x(lon) { return this.ox + (lon - B.lonMin) * this.scale; },
    y(lat) { return this.oy + (B.latMax - lat) * this.scale; },
    lon(px) { return B.lonMin + (px - this.ox) / this.scale; },
    lat(py) { return B.latMax - (py - this.oy) / this.scale; },
  });

  // -------------------- IDW interpolation -------------------------------
  // Returns a Float32 grid of interpolated monthly rainfall (mm) at the given
  // grid resolution, plus the basin-mean for anomaly reference.
  WP.interpolate = function (opts) {
    const { gw, gh, month, power, radiusDeg } = opts;
    const trend = opts.trend || 0; // 0..1 multi-year drying severity
    const st = WP.STATIONS;
    const n = st.length;
    // pre-extract station values for this month (apply drying trend, biased to
    // already-cleared / seasonal stations — clearing breaks the rain cycle)
    const sv = new Float32Array(n), sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = month < 0 ? st[i].annual / 12 : st[i].monthly[month];
      v *= 1 - trend * (0.10 + (1 - st[i].forest) * 0.40);
      sv[i] = v;
      sx[i] = st[i].lon; sy[i] = st[i].lat;
    }
    const grid = new Float32Array(gw * gh);
    const inb = new Uint8Array(gw * gh);
    const r2 = radiusDeg * radiusDeg;
    let basinSum = 0, basinCount = 0;

    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        const idx = gy * gw + gx;
        let num = 0, den = 0, exact = -1;
        for (let i = 0; i < n; i++) {
          const dx = lon - sx[i], dy = lat - sy[i];
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (d2 < 1e-6) { exact = i; break; }
          const w = 1 / Math.pow(d2, power / 2);
          num += w * sv[i]; den += w;
        }
        let val;
        if (exact >= 0) val = sv[exact];
        else if (den > 0) val = num / den;
        else val = NaN; // outside search radius of every gauge
        grid[idx] = val;
        const inside = WP.inBasin(lon, lat);
        inb[idx] = inside ? 1 : 0;
        if (inside && !isNaN(val)) { basinSum += val; basinCount++; }
      }
    }
    return { grid, inb, gw, gh, basinMean: basinCount ? basinSum / basinCount : 0 };
  };

  // -------------------- Ordinary Kriging --------------------------------
  // Exponential variogram with adjustable practical range + nugget fraction.
  // The Lagrange-constrained OK system is solved ONCE (matrix inverse), then a
  // weight-projection vector p makes each cell estimate a single dot product:
  //   estimate(x) = p · b(x),  where b(x)[i] = γ(|x - gauge_i|), b[n] = 1.
  function invertMatrix(A, m) {
    // Gauss-Jordan with partial pivoting; returns inverse of m×m matrix A.
    const M = [];
    for (let i = 0; i < m; i++) {
      M.push(new Float64Array(2 * m));
      for (let j = 0; j < m; j++) M[i][j] = A[i][j];
      M[i][m + i] = 1;
    }
    for (let c = 0; c < m; c++) {
      let piv = c;
      for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (piv !== c) { const t = M[piv]; M[piv] = M[c]; M[c] = t; }
      let d = M[c][c];
      if (Math.abs(d) < 1e-12) d = d < 0 ? -1e-12 : 1e-12;
      const inv = 1 / d;
      for (let j = 0; j < 2 * m; j++) M[c][j] *= inv;
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let j = 0; j < 2 * m; j++) M[r][j] -= f * M[c][j];
      }
    }
    const Inv = [];
    for (let i = 0; i < m; i++) { Inv.push(new Float64Array(m)); for (let j = 0; j < m; j++) Inv[i][j] = M[i][m + j]; }
    return Inv;
  }

  WP.krige = function (opts) {
    const { gw, gh, month } = opts;
    const range = Math.max(0.5, opts.range || 8);
    const nuggetFrac = Math.max(0, Math.min(0.95, opts.nugget == null ? 0.05 : opts.nugget));
    const trend = opts.trend || 0;
    const st = WP.STATIONS;
    const n = st.length;
    const z = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let v = month < 0 ? st[i].annual / 12 : st[i].monthly[month];
      v *= 1 - trend * (0.10 + (1 - st[i].forest) * 0.40);
      z[i] = v; sx[i] = st[i].lon; sy[i] = st[i].lat; mean += v;
    }
    mean /= n;
    let varr = 0; for (let i = 0; i < n; i++) varr += (z[i] - mean) * (z[i] - mean);
    varr /= n;
    const sill = varr > 1e-6 ? varr : 1;
    const nug = nuggetFrac * sill;
    const k = 3 / range; // exponential reaches ~95% sill at 'range'
    const gamma = (h) => (h <= 0 ? 0 : nug + (sill - nug) * (1 - Math.exp(-k * h)));

    // Build OK system A (m×m), m = n+1
    const m = n + 1;
    const A = [];
    for (let i = 0; i < m; i++) A.push(new Float64Array(m));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const g = gamma(Math.hypot(sx[i] - sx[j], sy[i] - sy[j]));
        A[i][j] = g; A[j][i] = g;
      }
      A[i][n] = 1; A[n][i] = 1;
    }
    A[n][n] = 0;
    const Ainv = invertMatrix(A, m);
    // weight-projection vector: p[j] = Σ_i z[i] · Ainv[i][j]
    const p = new Float64Array(m);
    for (let j = 0; j < m; j++) { let s = 0; for (let i = 0; i < n; i++) s += z[i] * Ainv[i][j]; p[j] = s; }
    const pn = p[n];

    const grid = new Float32Array(gw * gh);
    const inb = new Uint8Array(gw * gh);
    let basinSum = 0, basinCount = 0;
    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        const idx = gy * gw + gx;
        let est = pn; // b[n] = 1 term
        for (let i = 0; i < n; i++) est += p[i] * gamma(Math.hypot(lon - sx[i], lat - sy[i]));
        if (est < 0) est = 0;
        grid[idx] = est;
        const inside = WP.inBasin(lon, lat);
        inb[idx] = inside ? 1 : 0;
        if (inside) { basinSum += est; basinCount++; }
      }
    }
    return { grid, inb, gw, gh, basinMean: basinCount ? basinSum / basinCount : 0 };
  };

  // Build the ordinary-kriging system for the current month and return the
  // inverse matrix + station values, for closed-form leave-one-out CV.
  WP.krigeSystem = function (range, nugget, month, trend) {
    range = Math.max(0.5, range || 8);
    const nuggetFrac = Math.max(0, Math.min(0.95, nugget == null ? 0.05 : nugget));
    trend = trend || 0;
    const st = WP.STATIONS, n = st.length;
    const z = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      let v = month < 0 ? st[i].annual / 12 : st[i].monthly[month];
      v *= 1 - trend * (0.10 + (1 - st[i].forest) * 0.40);
      z[i] = v; sx[i] = st[i].lon; sy[i] = st[i].lat; mean += v;
    }
    mean /= n;
    let varr = 0; for (let i = 0; i < n; i++) varr += (z[i] - mean) * (z[i] - mean);
    varr /= n;
    const sill = varr > 1e-6 ? varr : 1, nug = nuggetFrac * sill, k = 3 / range;
    const gamma = (h) => (h <= 0 ? 0 : nug + (sill - nug) * (1 - Math.exp(-k * h)));
    const m = n + 1, A = [];
    for (let i = 0; i < m; i++) A.push(new Float64Array(m));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) { const g = gamma(Math.hypot(sx[i] - sx[j], sy[i] - sy[j])); A[i][j] = g; A[j][i] = g; }
      A[i][n] = 1; A[n][i] = 1;
    }
    A[n][n] = 0;
    return { Ainv: invertMatrix(A, m), z, m, n };
  };

  // -------------------- pocket classification ---------------------------
  // For each grid cell combine interpolated rainfall anomaly + forest cover +
  // surface temperature into a class:  +1 wet pocket, -1 dry pocket, 0 neither.
  // Also returns continuous score fields for smooth contouring.
  WP.classifyPockets = function (interp, sens, cache) {
    const { grid, gw, gh, basinMean } = interp;
    const wetField = new Float32Array(gw * gh);
    const dryField = new Float32Array(gw * gh);
    const cls = new Int8Array(gw * gh);
    const s = sens == null ? 1 : sens; // sensitivity multiplier
    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        const idx = gy * gw + gx;
        if (!WP.inBasin(lon, lat) || isNaN(grid[idx])) continue;
        const anom = basinMean > 0 ? (grid[idx] - basinMean) / basinMean : 0;
        const f = cache ? cache.forest[idx] : WP.forestAt(lon, lat);
        const t = cache ? cache.temp[idx] : WP.tempAt(lon, lat);
        // WET: clearly above-norm rainfall + intact canopy + cool surface
        const wet = (anom - 0.15) * 3.2 + (f - 0.86) * 3.4 + (26.4 - t) * 0.28;
        // DRY: rainfall below norm + low forest + hot surface
        const dry = (-anom - 0.08) * 3 + (0.58 - f) * 4 + (t - 27.6) * 0.28;
        wetField[idx] = wet * s;
        dryField[idx] = dry * s;
        if (wet > 0 && wet >= dry) cls[idx] = 1;
        else if (dry > 0) cls[idx] = -1;
      }
    }
    return { wetField, dryField, cls, gw, gh };
  };

  // -------------------- temperature interpolation -----------------------
  // IDW surface of the real station temperatures for a given month (°C).
  WP.interpTemp = function (gw, gh, month, power, radiusDeg) {
    const st = WP.STATIONS, n = st.length;
    const sv = new Float32Array(n), sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tm = st[i].tempMonthly;
      sv[i] = tm && tm[month] != null ? tm[month] : st[i].temp;
      sx[i] = st[i].lon; sy[i] = st[i].lat;
    }
    const grid = new Float32Array(gw * gh);
    const r2 = radiusDeg * radiusDeg, p = power;
    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        let num = 0, den = 0, exact = -1;
        for (let i = 0; i < n; i++) {
          const dx = lon - sx[i], dy = lat - sy[i], d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (d2 < 1e-6) { exact = i; break; }
          const w = 1 / Math.pow(d2, p / 2);
          num += w * sv[i]; den += w;
        }
        grid[gy * gw + gx] = exact >= 0 ? sv[exact] : den > 0 ? num / den : NaN;
      }
    }
    return grid;
  };

  // -------------------- field smoothing ---------------------------------
  // Box-blur passes over a scalar grid; smooths marching-squares contours so
  // pocket outlines read as flowing isolines rather than grid stair-steps.
  WP.smoothField = function (field, gw, gh, passes) {
    let src = field;
    for (let p = 0; p < (passes || 1); p++) {
      const dst = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          let s = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= gh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= gw) continue;
              s += src[yy * gw + xx]; c++;
            }
          }
          dst[y * gw + x] = s / c;
        }
      }
      src = dst;
    }
    return src;
  };

  // -------------------- marching squares --------------------------------
  // Extract iso-contour line segments (at iso=0) from a scalar field.
  // Returns array of [x0,y0,x1,y1] in GRID coordinates (0..gw, 0..gh).
  WP.marchingSquares = function (field, gw, gh, iso) {
    const segs = [];
    const v = (x, y) => field[y * gw + x];
    const lerp = (a, b) => (iso - a) / (b - a);
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const tl = v(x, y), tr = v(x + 1, y), br = v(x + 1, y + 1), bl = v(x, y + 1);
        let c = 0;
        if (tl > iso) c |= 8;
        if (tr > iso) c |= 4;
        if (br > iso) c |= 2;
        if (bl > iso) c |= 1;
        if (c === 0 || c === 15) continue;
        // edge crossing points
        const top = [x + lerp(tl, tr), y];
        const right = [x + 1, y + lerp(tr, br)];
        const bottom = [x + lerp(bl, br), y + 1];
        const left = [x, y + lerp(tl, bl)];
        const push = (a, b) => segs.push([a[0], a[1], b[0], b[1]]);
        switch (c) {
          case 1: push(left, bottom); break;
          case 2: push(bottom, right); break;
          case 3: push(left, right); break;
          case 4: push(top, right); break;
          case 5: push(left, top); push(bottom, right); break;
          case 6: push(top, bottom); break;
          case 7: push(left, top); break;
          case 8: push(left, top); break;
          case 9: push(top, bottom); break;
          case 10: push(left, bottom); push(top, right); break;
          case 11: push(top, right); break;
          case 12: push(left, right); break;
          case 13: push(bottom, right); break;
          case 14: push(left, bottom); break;
        }
      }
    }
    return segs;
  };

  // -------------------- inspect a single point --------------------------
  // Returns full readout for a clicked location, incl. nearest gauges + weights.
  WP.inspect = function (lon, lat, opts) {
    const { month, power, radiusDeg, interp } = opts;
    const trend = opts.trend || 0;
    const st = WP.STATIONS;
    const r2 = radiusDeg * radiusDeg;
    const contribs = [];
    let num = 0, den = 0, exact = null;
    for (let i = 0; i < st.length; i++) {
      const dx = lon - st[i].lon, dy = lat - st[i].lat;
      const d2 = dx * dx + dy * dy;
      let sval = month < 0 ? st[i].annual / 12 : st[i].monthly[month];
      sval *= 1 - trend * (0.10 + (1 - st[i].forest) * 0.40);
      if (d2 <= r2 && d2 >= 1e-6) {
        const w = 1 / Math.pow(d2, power / 2);
        num += w * sval; den += w;
        contribs.push({ st: st[i], dist: Math.sqrt(d2), w, val: sval });
      } else if (d2 < 1e-6) { exact = st[i]; }
    }
    let rain = exact ? (month < 0 ? exact.annual / 12 : exact.monthly[month]) * (1 - trend * (0.10 + (1 - exact.forest) * 0.40)) : den > 0 ? num / den : NaN;
    // If a computed surface is supplied, read the displayed value from it so the
    // readout matches whichever method (IDW or kriging) produced the surface.
    if (interp && interp.grid) {
      const gx = Math.floor(((lon - B.lonMin) / (B.lonMax - B.lonMin)) * interp.gw);
      const gy = Math.floor(((B.latMax - lat) / (B.latMax - B.latMin)) * interp.gh);
      if (gx >= 0 && gx < interp.gw && gy >= 0 && gy < interp.gh) {
        const gv = interp.grid[gy * interp.gw + gx];
        if (!isNaN(gv)) rain = gv;
      }
    }
    contribs.sort((a, b) => b.w - a.w);
    const totW = contribs.reduce((s, c) => s + c.w, 0) || 1;
    contribs.forEach((c) => (c.share = c.w / totW));
    const f = WP.forestAt(lon, lat);
    const t = WP.tempAt(lon, lat);
    const basinMean = interp ? interp.basinMean : 0;
    const anom = basinMean > 0 && !isNaN(rain) ? (rain - basinMean) / basinMean : 0;
    let klass = "Neutral";
    const wet = (anom - 0.15) * 3.2 + (f - 0.86) * 3.4 + (26.4 - t) * 0.28;
    const dry = (-anom - 0.08) * 3 + (0.58 - f) * 4 + (t - 27.6) * 0.28;
    if (wet > 0 && wet >= dry) klass = "Wet pocket";
    else if (dry > 0) klass = "Dry pocket";
    return {
      lon, lat, rain, forest: f, temp: t, anom, klass,
      inBasin: WP.inBasin(lon, lat),
      contribs: contribs.slice(0, 4),
      ngauges: contribs.length,
    };
  };

  // -------------------- cached static fields ----------------------------
  // Forest cover & surface temperature do not change with IDW params/month,
  // so build them once per grid resolution for fast pocket detection + draw.
  WP.cacheFields = function (gw, gh) {
    const forest = new Float32Array(gw * gh);
    const temp = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        const idx = gy * gw + gx;
        forest[idx] = WP.forestAt(lon, lat);
        temp[idx] = WP.tempAt(lon, lat);
      }
    }
    return { forest, temp, gw, gh };
  };

})();
