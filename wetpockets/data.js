/* ============================================================================
   Wet Pockets — embedded illustrative dataset + ecological field model
   ----------------------------------------------------------------------------
   ALL DATA HERE IS ILLUSTRATIVE / MODELLED. It is hand-built to mirror the
   *kind* of data published by Brazil's INMET / ANA gauge networks, CEMADEN,
   and satellite products (TRMM/GPM rainfall, MODIS forest cover & land-surface
   temperature). It is NOT a climate or land-use study — it is a teaching model.
   ============================================================================ */
(function () {
  const WP = (window.WP = window.WP || {});

  // Continental frame: ~12°N–34°S, ~34°W–82°W
  const BOUNDS = (WP.BOUNDS = { lonMin: -82, lonMax: -34, latMin: -34, latMax: 12 });

  // -------------------------------------------------------------------------
  // Deterministic value noise (so fields are stable across reloads)
  // -------------------------------------------------------------------------
  function hash(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y) {
    let s = 0, amp = 0.5, freq = 1;
    for (let i = 0; i < 4; i++) { s += amp * vnoise(x * freq, y * freq); amp *= 0.5; freq *= 2.1; }
    return s; // ~0..1
  }
  WP.fbm = fbm;

  // -------------------------------------------------------------------------
  // The "arc of deforestation" — southern & eastern rim of the basin.
  // Forest clearing concentrates along this curve (Rondônia → Mato Grosso →
  // southern Pará → Maranhão). Modelled as a polyline; clearing intensity
  // falls off with distance from it.
  // -------------------------------------------------------------------------
  const ARC = [
    [-69.5, -10.8], [-66.0, -11.0], [-63.0, -10.5], [-60.2, -12.0],
    [-57.5, -12.6], [-55.6, -12.0], [-54.0, -10.6], [-52.2, -8.4],
    [-50.3, -6.6], [-49.0, -5.2], [-47.6, -4.4], [-46.6, -3.4],
  ];

  function segDistDeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }
  function distToArc(lon, lat) {
    let m = Infinity;
    for (let i = 0; i < ARC.length - 1; i++) {
      const d = segDistDeg(lon, lat, ARC[i][0], ARC[i][1], ARC[i + 1][0], ARC[i + 1][1]);
      if (d < m) m = d;
    }
    return m;
  }
  WP.ARC = ARC;

  // -------------------------------------------------------------------------
  // Real geography (WP.BASIN — HydroBASINS Amazon divide, WP.LAND/WP.COUNTRIES
  // coastline & borders, WP.RIVERS network, WP.inBasin, WP.isLand) is defined in
  // geo.js, which is loaded BEFORE this file.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // FOREST COVER FRACTION  (0 cleared → 1 intact canopy)  — "MODIS-like"
  // -------------------------------------------------------------------------
  function forestAt(lon, lat) {
    const d = distToArc(lon, lat);
    // clearing band: strongest on the arc, fades over ~3°
    const clearing = Math.exp(-(d * d) / (2 * 1.9 * 1.9));
    // patchy texture inside the cleared band (fishbone clearings)
    const tex = fbm(lon * 0.9 + 30, lat * 0.9 + 30);
    let f = 0.97 - clearing * (0.62 + tex * 0.34);
    // subtropics / cerrado fringe south of basin: naturally lower cover
    if (lat < -15) f -= (Math.min(1, (-15 - lat) / 8)) * 0.4;
    // a couple of intact strongholds (NW Solimões, upper Negro) stay high
    f += Math.exp(-(((lon + 70) ** 2) / 40 + ((lat + 2) ** 2) / 30)) * 0.06;
    // mild background variation
    f += (fbm(lon * 2.0 + 7, lat * 2.0 + 7) - 0.5) * 0.06;
    return Math.max(0.04, Math.min(0.99, f));
  }
  WP.forestAt = forestAt;

  // -------------------------------------------------------------------------
  // SURFACE TEMPERATURE (°C). When real station temperatures are loaded, the
  // field is the interpolated surface of those gauges (set via WP.setTempGrid);
  // otherwise it falls back to a modelled "cleared land is hotter" field.
  // -------------------------------------------------------------------------
  function tempModel(lon, lat) {
    const f = forestAt(lon, lat);
    let t = 25.5 + (1 - f) * 9.5;        // canopy cools, bare ground heats
    t += Math.max(0, (Math.abs(lat) - 6)) * 0.18; // gentle latitudinal warming toward subtropics edge
    t += (fbm(lon * 1.7 + 50, lat * 1.7 + 50) - 0.5) * 2.4;
    if (lon < -75) t -= Math.min(7, (-75 - lon) * 1.6); // Andes / high west = cooler
    return t;
  }
  WP.tempModel = tempModel;

  let TEMPGRID = null; // { grid, gw, gh } — real interpolated temperature
  WP.setTempGrid = function (g) { TEMPGRID = g; };
  function tempAt(lon, lat) {
    if (TEMPGRID) {
      const b = WP.BOUNDS;
      let gx = Math.floor(((lon - b.lonMin) / (b.lonMax - b.lonMin)) * TEMPGRID.gw);
      let gy = Math.floor(((b.latMax - lat) / (b.latMax - b.latMin)) * TEMPGRID.gh);
      gx = Math.max(0, Math.min(TEMPGRID.gw - 1, gx));
      gy = Math.max(0, Math.min(TEMPGRID.gh - 1, gy));
      const v = TEMPGRID.grid[gy * TEMPGRID.gw + gx];
      if (!isNaN(v)) return v;
    }
    return tempModel(lon, lat);
  }
  WP.tempAt = tempAt;

  // -------------------------------------------------------------------------
  // "TRUE" RAINFALL FIELD (annual, mm) used to seed gauge readings.
  // Wetter to the west (Andean uplift + recycling) and near the equator;
  // suppressed where the canopy is cleared (the rain-cycle is broken).
  // -------------------------------------------------------------------------
  function trueAnnualRain(lon, lat) {
    let r = 2050;
    r += Math.max(0, (-(lon) - 50)) * 26;            // wetter west
    r -= Math.max(0, (Math.abs(lat + 1) - 3)) * 52;  // drier away from equatorial belt
    const f = forestAt(lon, lat);
    r -= (1 - f) * 360;                               // clearing suppresses local rain
    if (lon < -76) r -= Math.max(0, (-76 - lon)) * 120; // Pacific/Andes rain-shadow side
    return Math.max(420, r);
  }
  WP.trueAnnualRain = trueAnnualRain;

  // Monthly seasonality. Southern/arc stations have a sharper dry season.
  function seasonalFactor(month, lat, dryFactor) {
    // month 0=Jan. Wet peak ~Feb (south of equator). North of equator shifts.
    const peak = lat > 2 ? 5 : 1;
    const amp = 0.34 + dryFactor * 0.52;
    return 1 + amp * Math.cos((2 * Math.PI * (month - peak)) / 12);
  }
  WP.seasonalFactor = seasonalFactor;

  function dryFactorAt(lon, lat) {
    const f = forestAt(lon, lat);
    return Math.max(0, Math.min(1, (1 - f) * 0.7 + Math.max(0, Math.abs(lat) - 4) * 0.05));
  }
  WP.dryFactorAt = dryFactorAt;

  // Monthly rainfall (mm) at any point in space, for a given month index.
  // (Used for the basin-norm reference & the field model; the surface the user
  //  sees is interpolated from gauges only.)
  function monthlyRainModel(lon, lat, month) {
    const annual = trueAnnualRain(lon, lat);
    const df = dryFactorAt(lon, lat);
    return (annual / 12) * seasonalFactor(month, lat, df);
  }
  WP.monthlyRainModel = monthlyRainModel;

  // -------------------------------------------------------------------------
  // GAUGE STATIONS — named, with coordinates. Readings are sampled from the
  // model + small per-station scatter (instrument/site noise) so that the
  // interpolation has real work to do.
  // -------------------------------------------------------------------------
  const RAW_STATIONS = [
    // [name, country, lon, lat]
    ["Manaus", "BR", -60.02, -3.10], ["Belém", "BR", -48.50, -1.46],
    ["Santarém", "BR", -54.71, -2.44], ["Porto Velho", "BR", -63.90, -8.76],
    ["Rio Branco", "BR", -67.81, -9.97], ["Macapá", "BR", -51.07, 0.03],
    ["Boa Vista", "BR", -60.67, 2.82], ["Tefé", "BR", -64.71, -3.35],
    ["Tabatinga", "BR", -69.94, -4.25], ["Coari", "BR", -63.14, -4.08],
    ["Itacoatiara", "BR", -58.44, -3.14], ["Parintins", "BR", -56.74, -2.63],
    ["Altamira", "BR", -52.21, -3.20], ["Marabá", "BR", -49.13, -5.37],
    ["Itaituba", "BR", -55.98, -4.28], ["S.G. da Cachoeira", "BR", -67.08, -0.13],
    ["Humaitá", "BR", -63.02, -7.51], ["Lábrea", "BR", -64.80, -7.26],
    ["Cruzeiro do Sul", "BR", -72.67, -7.63], ["Sinop", "BR", -55.50, -11.86],
    ["Sorriso", "BR", -55.71, -12.54], ["Alta Floresta", "BR", -56.09, -9.87],
    ["Vilhena", "BR", -60.15, -12.74], ["Ji-Paraná", "BR", -61.95, -10.88],
    ["Ariquemes", "BR", -63.04, -9.91], ["Cáceres", "BR", -57.68, -16.07],
    ["Cuiabá", "BR", -56.10, -15.60], ["Redenção", "BR", -49.99, -8.03],
    ["S. Félix do Xingu", "BR", -51.99, -6.64], ["Novo Progresso", "BR", -55.38, -7.04],
    ["Imperatriz", "BR", -47.49, -5.53], ["Açailândia", "BR", -47.50, -4.95],
    ["Paragominas", "BR", -47.35, -2.99], ["Tucuruí", "BR", -49.67, -3.77],
    ["Óbidos", "BR", -55.52, -1.92], ["Carauari", "BR", -66.90, -4.88],
    ["Eirunepé", "BR", -69.87, -6.66], ["Borba", "BR", -59.59, -4.39],
    ["Maués", "BR", -57.72, -3.38], ["Manicoré", "BR", -61.30, -5.81],
    ["Iquitos", "PE", -73.25, -3.74], ["Pucallpa", "PE", -74.55, -8.39],
    ["Pto. Maldonado", "PE", -69.19, -12.59], ["Tarapoto", "PE", -76.37, -6.49],
    ["Yurimaguas", "PE", -76.12, -5.90], ["Leticia", "CO", -69.94, -4.21],
    ["Mitú", "CO", -70.23, 1.20], ["Florencia", "CO", -75.61, 1.61],
    ["Pto. Inírida", "CO", -67.92, 3.87], ["Lago Agrio", "EC", -76.88, 0.09],
    ["Puyo", "EC", -77.99, -1.49], ["Riberalta", "BO", -66.06, -11.01],
    ["Cobija", "BO", -68.77, -11.03], ["Trinidad", "BO", -64.90, -14.83],
    ["Guayaramerín", "BO", -65.36, -10.83], ["Pto. Ayacucho", "VE", -67.49, 5.66],
    ["Santa Elena", "VE", -61.11, 4.60],
  ];

  const STATIONS = (WP.STATIONS = RAW_STATIONS.map((s, i) => {
    const [name, country, lon, lat] = s;
    const clim = (WP.CLIMATE || {})[name];
    let monthly, annual, temp, tempMonthly;
    if (clim) {
      // REAL ERA5 climatology (via Open-Meteo) — precipitation + air temperature
      monthly = clim.monthlyP.slice();
      annual = monthly.reduce((a, b) => a + b, 0);
      tempMonthly = clim.monthlyT.map((t) => (t == null ? null : t));
      const valid = tempMonthly.filter((t) => t != null);
      temp = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : tempAt(lon, lat);
    } else {
      // fallback to the synthetic model if a station has no climatology
      annual = Math.round(trueAnnualRain(lon, lat) * (0.94 + hash(i + 1, i * 3 + 5) * 0.12));
      const df = dryFactorAt(lon, lat);
      monthly = [];
      for (let m = 0; m < 12; m++) {
        const noise = 0.9 + hash(i + 1, m + 13) * 0.2;
        monthly.push(Math.round((annual / 12) * seasonalFactor(m, lat, df) * noise));
      }
      temp = tempAt(lon, lat);
      tempMonthly = monthly.map(() => temp);
    }
    return {
      id: i, name, country, lon, lat,
      annual: Math.round(annual),
      monthly,
      tempMonthly,
      forest: forestAt(lon, lat),
      temp: temp,
    };
  }));
  // keep a pristine copy so the user can reset after importing their own data
  const SAMPLE_STATIONS = STATIONS.map((s) => Object.assign({}, s, { monthly: s.monthly.slice() }));
  WP.resetStations = function () {
    WP.STATIONS = SAMPLE_STATIONS.map((s) => Object.assign({}, s, { monthly: s.monthly.slice() }));
    return WP.STATIONS;
  };

  // Build full station records from imported rows. Each row may give 12 monthly
  // values, or just an annual total (then a basin-typical seasonality is synthesised).
  // forest/temp come from the model fields at the gauge location (satellite-style).
  WP.setStations = function (rows) {
    WP.STATIONS = rows.map((r, i) => {
      const lon = r.lon, lat = r.lat;
      let monthly = r.monthly, annual = r.annual;
      const df = dryFactorAt(lon, lat);
      if (monthly && monthly.length === 12) {
        annual = monthly.reduce((a, b) => a + b, 0);
      } else {
        monthly = [];
        for (let m = 0; m < 12; m++) monthly.push(Math.round((annual / 12) * seasonalFactor(m, lat, df)));
      }
      return {
        id: i, name: r.name || ("Gauge " + (i + 1)), country: r.country || "",
        lon, lat, annual: Math.round(annual), monthly: monthly.map((v) => Math.round(v)),
        tempMonthly: monthly.map(() => tempModel(lon, lat)),
        forest: forestAt(lon, lat), temp: tempModel(lon, lat),
      };
    });
    return WP.STATIONS;
  };

  // -------------------------------------------------------------------------
  // PRIORITY SUB-REGIONS — named boxes evaluated by composite risk/value.
  // -------------------------------------------------------------------------
  WP.REGIONS = [
    { id: "rondonia", name: "Rondônia Arc (Vilhena–Ji-Paraná)", kind: "risk",
      lon: -61.2, lat: -11.2, r: 2.4,
      response: "Reforestation corridor", desc: "Fishbone clearing has fragmented the canopy; reconnecting forest blocks restores recycling between the Madeira and the highlands." },
    { id: "matogrosso", name: "Mato Grosso Soy Front (Sinop–Sorriso)", kind: "risk",
      lon: -55.6, lat: -12.1, r: 2.3,
      response: "Agroforestry transition", desc: "Large mechanised clearings drive the hottest surface temperatures in the basin and the sharpest dry-season rainfall deficit." },
    { id: "xingu", name: "Southern Pará (São Félix do Xingu)", kind: "risk",
      lon: -52.0, lat: -6.9, r: 2.2,
      response: "Protected-area reinforcement", desc: "Active frontier between intact Xingu forest and pasture; the interpolated surface shows a dry pocket opening upwind of standing forest." },
    { id: "maranhao", name: "Maranhão–E. Pará Frontier", kind: "risk",
      lon: -47.6, lat: -4.4, r: 2.0,
      response: "Monitoring priority", desc: "Long-cleared, fragmented and gauge-sparse; interpolation is least certain here, so new stations would sharpen the picture most." },
    { id: "tapajos", name: "Tapajós Headwaters (Novo Progresso)", kind: "risk",
      lon: -55.4, lat: -7.6, r: 1.9,
      response: "Reforestation corridor", desc: "Roadside clearing is pushing a warm, drying wedge into otherwise intact forest along the BR-163." },
    { id: "solimoes", name: "NW Solimões Core", kind: "protect",
      lon: -70.0, lat: -3.6, r: 2.6,
      response: "Protected-area reinforcement", desc: "Intact, cool and the wettest reach in the basin — the recycling engine that feeds the flying rivers downwind. High value to keep whole." },
    { id: "negro", name: "Upper Rio Negro", kind: "protect",
      lon: -66.0, lat: 0.4, r: 2.4,
      response: "Protected-area reinforcement", desc: "Near-pristine canopy and cool surface; an anchor of the northern moisture budget." },
  ];

})();
