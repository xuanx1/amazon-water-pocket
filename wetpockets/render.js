/* ============================================================================
   Wet Pockets — rendering (canvas)
   Colour ramps map to ecological state. The interpolated rainfall surface is
   computed into a small offscreen buffer and drawn back up with smoothing so
   the IDW field reads as a continuous, contour-textured surface.
   ============================================================================ */
(function () {
  const WP = (window.WP = window.WP || {});
  const proj = WP.proj;

  // ---- colour ramps ----------------------------------------------------
  function lerpC(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    return lerpC(stops[i], stops[i + 1], seg - i);
  }
  // rainfall: pale → blue → deep ink-blue
  const RAIN = [[233, 224, 199], [180, 206, 206], [110, 168, 190], [58, 124, 168], [30, 84, 128], [18, 54, 92]];
  // forest: ochre cleared → olive → deep canopy green
  const FOREST = [[176, 120, 58], [199, 154, 75], [158, 168, 86], [94, 154, 63], [43, 122, 70], [20, 84, 50]];
  // temperature: cool slate-blue → cream → warm ochre → hot red
  const TEMP = [[74, 127, 174], [150, 178, 188], [226, 214, 178], [217, 138, 58], [181, 70, 47], [140, 40, 34]];
  // confidence: low (red, a guess) → amber → high (green, well sampled)
  const CONF = [[183, 71, 60], [206, 120, 64], [221, 178, 92], [150, 168, 96], [70, 140, 96]];
  WP.RAMPS = { RAIN, FOREST, TEMP, CONF };

  function rgb(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
  WP.rampColor = (which, t) => rgb(ramp(WP.RAMPS[which], t));

  // domain mappings (value → 0..1)
  const RAIN_MIN = 30, RAIN_MAX = 360;   // monthly mm display domain
  const TEMP_MIN = 21, TEMP_MAX = 30;
  WP.RAIN_DOMAIN = [RAIN_MIN, RAIN_MAX];
  WP.TEMP_DOMAIN = [TEMP_MIN, TEMP_MAX];

  // ---- build a clip path of the continent (in screen px) ---------------
  function pathFrom(pts, ctx) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = proj.x(pts[i][0]), y = proj.y(pts[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  WP.pathFrom = pathFrom;

  // build a path from multiple rings (for clip/fill/stroke of a multipolygon)
  function pathRings(rings, ctx) {
    ctx.beginPath();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const x = proj.x(ring[i][0]), y = proj.y(ring[i][1]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }
  WP.pathRings = pathRings;

  // =====================================================================
  // FIELD SURFACE  (rainfall / forest / temperature)
  // Renders into an offscreen grid buffer, then scales up smoothly.
  // =====================================================================
  WP.renderField = function (canvas, mode, interp, opts) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, dpr = opts.dpr;
    ctx.clearRect(0, 0, W, H);
    if (mode === "none") return;

    const gw = interp ? interp.gw : 200;
    const gh = interp ? interp.gh : Math.round(gw * (canvas.height / canvas.width));
    const buf = document.createElement("canvas");
    buf.width = gw; buf.height = gh;
    const bctx = buf.getContext("2d");
    const img = bctx.createImageData(gw, gh);
    const data = img.data;
    const B = WP.BOUNDS;

    for (let gy = 0; gy < gh; gy++) {
      const lat = B.latMax - ((gy + 0.5) / gh) * (B.latMax - B.latMin);
      for (let gx = 0; gx < gw; gx++) {
        const lon = B.lonMin + ((gx + 0.5) / gw) * (B.lonMax - B.lonMin);
        const o = (gy * gw + gx) * 4;
        let c, a = 255;
        const insideBasin = WP.inBasin(lon, lat);
        if (mode === "rainfall") {
          if (!interp) { a = 0; }
          else {
            const v = interp.grid[gy * gw + gx];
            if (isNaN(v)) { a = 0; }
            else {
              c = ramp(RAIN, (v - RAIN_MIN) / (RAIN_MAX - RAIN_MIN));
              a = 235;
            }
          }
        } else if (mode === "forest") {
          const f = opts.cache ? opts.cache.forest[gy * gw + gx] : WP.forestAt(lon, lat);
          c = ramp(FOREST, f);
        } else if (mode === "temp") {
          const tv = opts.cache ? opts.cache.temp[gy * gw + gx] : WP.tempAt(lon, lat);
          if (tv == null || isNaN(tv)) { a = 0; }
          else c = ramp(TEMP, (tv - TEMP_MIN) / (TEMP_MAX - TEMP_MIN));
        } else if (mode === "conf") {
          const cv = opts.confGrid ? opts.confGrid[gy * gw + gx] : 0;
          c = ramp(CONF, cv);
          a = insideBasin ? 220 : 70;
        }
        if (c) { data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = a; }
        else data[o + 3] = 0;
      }
    }
    bctx.putImageData(img, 0, 0);

    // clip rainfall to the basin (its valid domain); forest/temp to the real landmass
    ctx.save();
    ctx.scale(dpr, dpr);
    if (mode === "rainfall" || mode === "conf" || mode === "forest" || mode === "temp") { pathFrom(WP.BASIN, ctx); }
    else { pathRings(WP.FIELD_LAND || WP.LAND, ctx); }
    ctx.clip();
    const ctx2 = ctx; // already scaled
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = mode === "rainfall" ? 0.92 : 0.8;
    ctx.drawImage(buf, 0, 0, proj.w, proj.h);
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  // =====================================================================
  // GEOGRAPHY  (coast fill, basin, rivers, graticule, labels, stations)
  // =====================================================================
  WP.renderGeo = function (canvas, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = opts.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);

    // graticule (phosphor, faint)
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(54,230,255,0.10)";
    ctx.fillStyle = "rgba(54,230,255,0.4)";
    ctx.font = "10px 'IBM Plex Mono', monospace";
    const B = WP.BOUNDS;
    for (let lon = -80; lon <= -36; lon += 8) {
      ctx.beginPath(); ctx.moveTo(proj.x(lon), 0); ctx.lineTo(proj.x(lon), proj.h); ctx.stroke();
    }
    for (let lat = -32; lat <= 12; lat += 8) {
      ctx.beginPath(); ctx.moveTo(0, proj.y(lat)); ctx.lineTo(proj.w, proj.y(lat)); ctx.stroke();
    }

    // continent fill (subtle dark land tint) — only if no field beneath
    if (opts.landFill) {
      pathRings(WP.LAND, ctx);
      ctx.fillStyle = "rgba(16,16,40,0.5)";
      ctx.fill();
    }

    // coastline + political borders (real Natural Earth country outlines)
    pathRings(WP.LAND, ctx);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(120,150,235,0.4)";
    ctx.stroke();

    // basin outline
    if (opts.basin) {
      WP.pathFrom(WP.BASIN, ctx);
      ctx.closePath();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(54,230,255,0.85)";
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // rivers (real Natural Earth centerlines; each river = array of polylines)
    // (rivers are drawn on their own animated layer — see WP.renderRivers)
  };

  // =====================================================================
  // RIVERS  (own layer, redrawn every frame so the water can flow)
  //  - blue on the bare base map (where white would vanish), white over data
  //  - a solid base line plus bright dashes that march downstream = "flow"
  // =====================================================================
  WP.renderRivers = function (canvas, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = opts.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);
    if (!opts.show) return;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const blue = opts.color === "blue";
    const baseCol  = blue ? "rgba(70,200,235,0.8)"  : "rgba(255,255,255,0.55)";
    const glintCol = blue ? "rgba(150,235,255,0.98)" : "rgba(255,255,255,0.98)";
    const off = -(opts.phase || 0) * 7;   // marching offset → downstream flow
    for (const k in WP.RIVERS) {
      const lw = k === "Rio Amazonas" ? 2.8 : (k === "Rio Negro" || k === "Rio Madeira" || k === "Ucayali") ? 1.9 : 1.3;
      for (const line of WP.RIVERS[k]) {
        ctx.beginPath();
        for (let i = 0; i < line.length; i++) {
          const x = proj.x(line[i][0]), y = proj.y(line[i][1]);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.setLineDash([]);
        ctx.lineWidth = lw; ctx.strokeStyle = baseCol; ctx.stroke();   // solid base
        ctx.setLineDash([4, 20]); ctx.lineDashOffset = off;            // moving glints
        ctx.lineWidth = lw * 0.95; ctx.strokeStyle = glintCol; ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  };

  // country labels — positioned in open map areas, mostly outside the basin
  const COUNTRY_LABELS = [
    { name: "BRAZIL", lon: -45.5, lat: -9.5 },
    { name: "PERU", lon: -76.5, lat: -10.5 },
    { name: "COLOMBIA", lon: -73.0, lat: 2.9 },
    { name: "ECUADOR", lon: -79.2, lat: -1.2 },
    { name: "BOLIVIA", lon: -64.8, lat: -17.8 },
    { name: "VENEZUELA", lon: -66.2, lat: 7.0 },
    { name: "GUYANA", lon: -59.0, lat: 5.2 },
    { name: "SURINAME", lon: -55.8, lat: 4.2 },
    { name: "ARGENTINA", lon: -65.5, lat: -26.5 },
    { name: "CHILE", lon: -70.2, lat: -24.0 },
    { name: "PARAGUAY", lon: -58.0, lat: -23.6 },
    { name: "URUGUAY", lon: -55.8, lat: -32.8 },
  ];

  // =====================================================================
  // LABELS  (top layer — drawn above the field, pockets, flow and stations)
  // Cartographic text with a soft paper halo so it stays legible over data.
  // =====================================================================
  WP.renderLabels = function (canvas, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = opts.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);
    if (!opts.show) return;
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";

    const halo = (text, x, y, font, fill, size) => {
      ctx.font = font;
      ctx.lineWidth = size;
      ctx.strokeStyle = "rgba(3,14,10,0.85)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
    };

    // country labels (cartographic — set in open space around the basin)
    ctx.save();
    ctx.textAlign = "center";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "3px";
    for (const c of COUNTRY_LABELS) {
      halo(c.name, proj.x(c.lon), proj.y(c.lat), "600 11px 'IBM Plex Mono', monospace", "rgba(150,160,215,0.6)", 3);
    }
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.restore();

    // river labels
    const L = WP.RIVER_LABELS || {};
    for (const k in L) {
      halo(k, proj.x(L[k][0]) + 3, proj.y(L[k][1]) - 3, "italic 11px 'IBM Plex Mono', monospace", "rgba(120,225,255,0.92)", 3);
    }
    // basin label (drawn last, on top)
    if (opts.basin) {
      ctx.save();
      ctx.textAlign = "center";
      if ("letterSpacing" in ctx) ctx.letterSpacing = "4px";
      halo("AMAZON BASIN", proj.x(-62), proj.y(-1.3), "600 14px 'IBM Plex Mono', monospace", "rgba(54,230,255,0.85)", 3.5);
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
      ctx.restore();
    }
  };

  // ---- stations --------------------------------------------------------
  WP.renderStations = function (canvas, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = opts.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);
    const month = opts.month;
    const showVal = opts.gaugesOnly; // in gauges-only mode, colour the dots by reading
    for (const s of WP.STATIONS) {
      const x = proj.x(s.lon), y = proj.y(s.lat);
      const v = month < 0 ? s.annual / 12 : s.monthly[month];
      if (showVal) {
        const c = ramp(RAIN, (v - RAIN_MIN) / (RAIN_MAX - RAIN_MIN));
        ctx.beginPath(); ctx.arc(x, y, 6, 0, 7);
        ctx.fillStyle = rgb(c); ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(3,14,10,0.9)"; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 7);
        ctx.fillStyle = "rgba(150,235,255,0.95)"; ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = "rgba(3,14,10,0.9)"; ctx.stroke();
      }
    }
    // hover highlight
    if (opts.hover != null) {
      const s = WP.STATIONS[opts.hover];
      const x = proj.x(s.lon), y = proj.y(s.lat);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 7);
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(54,230,255,0.95)"; ctx.stroke();
    }
  };

  // ---- pocket contours (animated pulse handled by app via phase) -------
  WP.renderPockets = function (canvas, pockets, opts) {
    const ctx = canvas.getContext("2d");
    const dpr = opts.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);
    if (!pockets) return;
    const B = WP.BOUNDS;
    const sx = proj.scale * (B.lonMax - B.lonMin) / pockets.gw;
    const sy = proj.scale * (B.latMax - B.latMin) / pockets.gh;
    const gx0 = proj.x(B.lonMin), gy0 = proj.y(B.latMax);
    const phase = opts.phase || 0;

    const drawField = (field, color, glow) => {
      const segs = WP.marchingSquares(field, pockets.gw, pockets.gh, 0);
      if (!segs.length) return;
      ctx.beginPath();
      for (const sgmt of segs) {
        ctx.moveTo(gx0 + sgmt[0] * sx, gy0 + sgmt[1] * sy);
        ctx.lineTo(gx0 + sgmt[2] * sx, gy0 + sgmt[3] * sy);
      }
      const pulse = 0.55 + 0.45 * Math.sin(phase);
      ctx.save();
      ctx.shadowColor = glow; ctx.shadowBlur = 8 + 8 * pulse;
      ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.globalAlpha = 0.5 + 0.45 * pulse;
      ctx.stroke();
      ctx.restore();
    };
    drawField(pockets.dryField, "rgba(214,41,107,0.95)", "rgba(255,59,107,0.9)");
    drawField(pockets.wetField, "rgba(22,184,196,0.95)", "rgba(15,208,216,0.9)");
  };

})();
