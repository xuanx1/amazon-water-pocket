/* ============================================================================
   Wet Pockets — application orchestration
   ============================================================================ */
(function () {
  const WP = window.WP;
  const proj = WP.proj;
  const $ = (s) => document.querySelector(s);

  // ----- canvases -----
  const cv = { field: $("#field"), geo: $("#geo"), rivers: $("#rivers"), flow: $("#flow"), pockets: $("#pockets"), stations: $("#stations"), labels: $("#labels") };
  const stage = $("#stage");
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  // ----- grid resolution (rich) -----
  const GW = 260, GH = 250;
  let cache = null;            // {forest,temp}
  let interp = null;           // interpolation result
  let pockets = null;          // classify result
  let wetSegs = [], drySegs = []; // pre-projected pocket contour segments (px)
  let confGrid = null, confKey = "", gaugeStamp = 0; // interpolation-confidence field

  // ----- state -----
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const state = {
    base: "rainfall",
    ov: { pockets: true, flow: true, stations: true, geo: true },
    power: 2, radius: 9, sens: 1,
    method: "idw", kRange: 8, kNugget: 0.05,
    month: 1, yearIdx: 0, mode: "season", trend: 0,
    playing: false, compare: false, divX: 0.5,
    hoverStation: null, selRegion: null, tool: "inspect",
  };

  // dirty flags
  let needField = true, needStations = true, needGeo = true, needPockets = true;

  // ---------------------------------------------------------------- sizing
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return; // stage has no layout yet — wait for a later call
    proj.set(w, h);
    for (const k in cv) {
      cv[k].width = Math.round(w * DPR);
      cv[k].height = Math.round(h * DPR);
    }
    needField = needGeo = needStations = needPockets = true;
    if (state.compare) updateClip();
    if (typeof render === "function") render(); // draw immediately; don't depend on rAF
  }
  window.addEventListener("resize", resize);

  // ---------------------------------------------------------------- compute
  function recompute() {
    if (state.method === "krige") {
      interp = WP.krige({ gw: GW, gh: GH, month: state.month, range: state.kRange, nugget: state.kNugget, trend: state.trend });
    } else {
      interp = WP.interpolate({ gw: GW, gh: GH, month: state.month, power: state.power, radiusDeg: state.radius, trend: state.trend });
    }
    // real interpolated temperature surface for this month
    const tg = WP.interpTemp(GW, GH, state.month, 2.5, 14);
    WP.setTempGrid({ grid: tg, gw: GW, gh: GH });
    if (cache) cache.temp = tg;
    pockets = WP.classifyPockets(interp, state.sens, cache);
    buildPocketSegs();
    // interpolation-confidence field (only when gauges or radius change)
    const ck = Math.round(state.radius * 2) + "|" + gaugeStamp;
    if (ck !== confKey) { confGrid = WP.confidenceGrid(GW, GH, Math.max(6, state.radius)); confKey = ck; }
    // leave-one-out cross-validation skill
    if (WP.looCV) updateLoo(WP.looCV({ method: state.method, month: state.month, power: state.power, radiusDeg: state.radius, range: state.kRange, nugget: state.kNugget, trend: state.trend }));
  }

  function buildPocketSegs() {
    const B = WP.BOUNDS;
    const sx = proj.scale * (B.lonMax - B.lonMin) / GW;
    const sy = proj.scale * (B.latMax - B.latMin) / GH;
    const gx0 = proj.x(B.lonMin), gy0 = proj.y(B.latMax);
    const conv = (field) => {
      const sm = WP.smoothField(field, GW, GH, 2);
      return WP.marchingSquares(sm, GW, GH, 0).map((s) => [gx0 + s[0] * sx, gy0 + s[1] * sy, gx0 + s[2] * sx, gy0 + s[3] * sy]);
    };
    wetSegs = conv(pockets.wetField);
    drySegs = conv(pockets.dryField);
  }

  // ---------------------------------------------------------------- draws
  function drawField() {
    WP.renderField(cv.field, state.base, interp, { dpr: DPR, cache, confGrid });
  }
  function drawGeo() {
    WP.renderGeo(cv.geo, { dpr: DPR, basin: state.ov.geo, rivers: state.ov.geo, landFill: state.base === "none" });
    WP.renderLabels(cv.labels, { dpr: DPR, show: state.ov.geo, basin: state.ov.geo });
  }
  function drawStations() {
    if (!state.ov.stations && !state.compare) { clear(cv.stations); drawRegionHi(); drawTransectOverlay(); return; }
    WP.renderStations(cv.stations, { dpr: DPR, month: state.month, gaugesOnly: state.compare, hover: state.hoverStation });
    drawRegionHi();
    drawTransectOverlay();
  }
  function drawTransectOverlay() {
    if (!transectPts || !transectPts.length) return;
    const ctx = cv.stations.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(44,36,23,0.85)"; ctx.fillStyle = "rgba(44,36,23,0.9)";
    ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
    if (transectPts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(proj.x(transectPts[0][0]), proj.y(transectPts[0][1]));
      ctx.lineTo(proj.x(transectPts[1][0]), proj.y(transectPts[1][1]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    transectPts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(proj.x(p[0]), proj.y(p[1]), 5, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "600 9px 'IBM Plex Mono'"; ctx.fillText(i === 0 ? "A" : "B", proj.x(p[0]) - 3, proj.y(p[1]) + 3);
      ctx.fillStyle = "rgba(44,36,23,0.9)";
    });
    ctx.restore();
  }
  function drawRegionHi() {
    if (state.selRegion == null) return;
    const r = WP.REGIONS.find((x) => x.id === state.selRegion);
    if (!r) return;
    const ctx = cv.stations.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const x = proj.x(r.lon), y = proj.y(r.lat), rad = r.r * proj.scale;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7);
    ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.strokeStyle = r.kind === "protect" ? "rgba(21,176,189,0.95)" : "rgba(214,41,107,0.95)";
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(44,36,23,0.9)";
    ctx.font = "600 12px 'Spectral', serif";
    ctx.fillText(r.name, x - rad, y - rad - 6);
  }
  function clear(c) { const x = c.getContext("2d"); x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height); }

  function drawPockets(phase) {
    const ctx = cv.pockets.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, proj.w, proj.h);
    if (!state.ov.pockets) return;
    // clip contours (and their glow) to the real basin divide
    ctx.save();
    WP.pathFrom(WP.BASIN, ctx); ctx.closePath(); ctx.clip();
    const pulse = 0.5 + 0.5 * Math.sin(phase);
    const stroke = (segs, col, glow) => {
      if (!segs.length) return;
      ctx.beginPath();
      for (const s of segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
      ctx.save();
      ctx.shadowColor = glow; ctx.shadowBlur = 6 + 10 * pulse;
      ctx.lineWidth = 2.2; ctx.strokeStyle = col; ctx.globalAlpha = 0.45 + 0.5 * pulse;
      ctx.lineCap = "round"; ctx.stroke();
      ctx.restore();
    };
    stroke(drySegs, "rgba(214,41,107,1)", "rgba(255,59,107,0.95)");
    stroke(wetSegs, "rgba(22,184,196,1)", "rgba(15,208,216,0.95)");
    ctx.restore();
  }

  // ---------------------------------------------------------------- loop
  let phase = 0, lastPlay = 0, lastTick = 0;
  // process pending redraws (called synchronously on interaction AND each frame)
  function render() {
    if (needField) { recompute(); drawField(); needField = false; needPockets = true; updatePriority(); }
    if (needGeo) { drawGeo(); needGeo = false; }
    if (needStations) { drawStations(); needStations = false; }
    drawPockets(phase);
  }
  function loop(ts) {
   ts = ts || performance.now();
   try {
    render();

    // flow
    if (state.ov.flow) { WP.flowStep(interp); WP.renderFlow(cv.flow, { dpr: DPR }); }
    else clear(cv.flow);

    // animated rivers (blue on bare base map, white over data)
    WP.renderRivers(cv.rivers, { dpr: DPR, show: state.ov.geo, color: state.base === "none" ? "blue" : "white", phase });

    // pocket pulse
    phase += 0.045;
    drawPockets(phase);

    // playback
    if (state.playing) {
      if (!lastPlay) lastPlay = ts;
      const interval = state.mode === "trend" ? 700 : 850;
      if (ts - lastPlay > interval) {
        lastPlay = ts;
        if (state.mode === "trend") {
          state.yearIdx = (state.yearIdx + 1) % 21;
          setTrend();
        } else {
          state.month = (state.month + 1) % 12;
        }
        syncSlider();
        needField = true; needStations = true;
      }
    }
   } catch (err) { console.error("loop", err); }
    lastTick = performance.now();
  }
  function rafTick(ts) { loop(ts); requestAnimationFrame(rafTick); }
  // Watchdog: if rAF is paused (e.g. backgrounded / non-painting context),
  // keep the loop alive with a timer so static content + state always render.
  function startLoop() {
    requestAnimationFrame(rafTick);
    setInterval(function () { if (performance.now() - lastTick > 120) loop(); }, 90);
  }

  // ---------------------------------------------------------------- controls
  // base layer
  $("#baseSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.base = b.dataset.base;
    $("#baseSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    needField = true; needGeo = true; updateLegend(); render();
  });
  // overlays
  document.querySelectorAll(".toggle[data-ov]").forEach((t) => {
    t.addEventListener("click", () => {
      const k = t.dataset.ov;
      state.ov[k] = !state.ov[k];
      t.classList.toggle("on", state.ov[k]);
      if (k === "geo") needGeo = true;
      if (k === "stations") needStations = true;
      if (k === "flow" && !state.ov.flow) clear(cv.flow);
      render();
    });
  });
  // sliders
  bindRange("#power", "#powerVal", (v) => v.toFixed(1), (v) => { state.power = v; needField = true; });
  bindRange("#radius", "#radiusVal", (v) => v.toFixed(1) + "°", (v) => { state.radius = v; needField = true; });
  bindRange("#sens", "#sensVal", (v) => v.toFixed(2) + "×", (v) => { state.sens = v; needField = true; });
  bindRange("#krange", "#rangeVal", (v) => v.toFixed(1) + "°", (v) => { state.kRange = v; needField = true; });
  bindRange("#knugget", "#nuggetVal", (v) => Math.round(v * 100) + "%", (v) => { state.kNugget = v; needField = true; });
  function bindRange(sel, valSel, fmt, fn) {
    const el = $(sel), v = $(valSel);
    el.addEventListener("input", () => { const x = parseFloat(el.value); v.textContent = fmt(x); fn(x); render(); });
  }

  // interpolation method toggle
  $("#methodSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.method = b.dataset.method;
    $("#methodSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    const krige = state.method === "krige";
    $("#idwControls").style.display = krige ? "none" : "";
    $("#krigeControls").style.display = krige ? "" : "none";
    $("#idwHint").innerHTML = krige
      ? "Ordinary kriging fits a variogram to the gauges. <b>Range</b> sets how far influence reaches; <b>nugget</b> adds local noise/uncertainty."
      : "Higher power → each gauge dominates its own neighbourhood (bullseyes). Lower power → smoother blend.";
    needField = true; render();
  });

  // gauge data import / reset
  $("#importBtn").addEventListener("click", () => $("#csvInput").click());
  $("#csvInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { importCSV(String(reader.result)); } catch (err) { setDataHint("Could not parse CSV — check the columns.", true); } };
    reader.readAsText(file);
    e.target.value = "";
  });
  $("#resetDataBtn").addEventListener("click", () => {
    WP.resetStations();
    gaugeStamp++;
    setDataHint("Real ERA5 climatology (Open-Meteo) at 57 stations. Import a CSV (<b>name, lon, lat</b> + <b>annual</b> or <b>jan…dec</b>) to use your own.");
    needField = true; needStations = true; render();
  });
  function setDataHint(html, warn) {
    const el = $("#dataHint"); el.innerHTML = html; el.style.color = warn ? "var(--dry)" : "";
  }
  const MON_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function importCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    if (lines.length < 2) throw new Error("empty");
    const split = (l) => l.split(",").map((s) => s.trim());
    const header = split(lines[0]).map((h) => h.toLowerCase());
    const col = (name) => header.indexOf(name);
    const iLon = col("lon") >= 0 ? col("lon") : col("longitude");
    const iLat = col("lat") >= 0 ? col("lat") : col("latitude");
    const iName = col("name"), iCountry = col("country");
    const iAnnual = col("annual");
    const monCols = MON_KEYS.map((k) => col(k));
    const hasMonthly = monCols.every((c) => c >= 0);
    if (iLon < 0 || iLat < 0) throw new Error("need lon/lat");
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = split(lines[i]);
      const lon = parseFloat(c[iLon]), lat = parseFloat(c[iLat]);
      if (isNaN(lon) || isNaN(lat)) continue;
      const row = { lon, lat, name: iName >= 0 ? c[iName] : "", country: iCountry >= 0 ? c[iCountry] : "" };
      if (hasMonthly) row.monthly = monCols.map((mc) => parseFloat(c[mc]) || 0);
      else if (iAnnual >= 0) row.annual = parseFloat(c[iAnnual]) || 0;
      else row.annual = 1800;
      rows.push(row);
    }
    if (!rows.length) throw new Error("no rows");
    WP.setStations(rows);
    gaugeStamp++;
    setDataHint("Imported <b>" + rows.length + "</b> gauges" + (hasMonthly ? " with monthly totals." : " (annual → synthesised seasonality)."));
    needField = true; needStations = true; render();
  }

  // export priority list
  $("#exportBtn").addEventListener("click", () => {
    const scored = WP.REGIONS.map((r) => ({ r, s: regionScore(r) }));
    const risks = scored.filter((x) => x.r.kind === "risk").sort((a, b) => b.s - a.s);
    const prot = scored.filter((x) => x.r.kind === "protect").sort((a, b) => b.s - a.s);
    const ordered = risks.concat(prot);
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const ctx = state.mode === "trend" ? (MONTHS[state.month] + " " + (2005 + state.yearIdx) + " (trend " + Math.round(state.trend * 100 / 0.62) + "%)") : MONTHS[state.month];
    let csv = "rank,region,type,composite_score,suggested_response,reasons,context,method\n";
    ordered.forEach((x, i) => {
      const rank = x.r.kind === "risk" ? (i + 1) : "protect";
      csv += [rank, esc(x.r.name), x.r.kind, x.s, esc(x.r.response), esc(x.r.desc), esc(ctx), state.method].join(",") + "\n";
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "wet-pockets-priority.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // month slider
  const monthEl = $("#month");
  monthEl.addEventListener("input", () => {
    if (state.mode === "trend") { state.yearIdx = parseInt(monthEl.value); setTrend(); }
    else { state.month = parseInt(monthEl.value); }
    syncSlider(); needField = true; needStations = true; render();
  });
  function setTrend() { state.trend = (state.yearIdx / 20) * 0.62; }
  function syncSlider() {
    if (state.mode === "trend") {
      $("#monthLabel").textContent = MONTHS[state.month] + " · " + (2005 + state.yearIdx);
      $("#yearLabel").textContent = "drying trend: " + Math.round(state.trend * 100 / 0.62) + "%";
      monthEl.value = state.yearIdx;
    } else {
      $("#monthLabel").textContent = MONTHS[state.month];
      $("#yearLabel").textContent = state.mode === "season" ? "dry season opens pockets →" : "";
      monthEl.value = state.month;
    }
  }

  // play
  $("#playBtn").addEventListener("click", () => {
    state.playing = !state.playing; lastPlay = 0;
    $("#playBtn").textContent = state.playing ? "❚❚" : "▶";
  });
  // modes
  $("#modeSeason").addEventListener("click", () => switchMode("season"));
  $("#modeTrend").addEventListener("click", () => switchMode("trend"));
  function switchMode(m) {
    state.mode = m;
    $("#modeSeason").classList.toggle("on", m === "season");
    $("#modeTrend").classList.toggle("on", m === "trend");
    if (m === "trend") { monthEl.min = 0; monthEl.max = 20; monthEl.step = 1; setTrend(); }
    else { monthEl.min = 0; monthEl.max = 11; monthEl.step = 1; state.trend = 0; }
    syncSlider(); needField = true; needStations = true; render();
  }

  // compare
  const divider = $("#divider");
  $("#cmpBtn").addEventListener("click", () => {
    state.compare = !state.compare;
    $("#cmpBtn").classList.toggle("on", state.compare);
    divider.style.display = state.compare ? "block" : "none";
    $("#cmpLeft").style.display = state.compare ? "block" : "none";
    $("#cmpRight").style.display = state.compare ? "block" : "none";
    if (state.compare) {
      cv.field.classList.add("compare-clip");
      cv.pockets.classList.add("compare-clip");
      updateClip();
    } else {
      cv.field.classList.remove("compare-clip");
      cv.pockets.classList.remove("compare-clip");
    }
    needStations = true; render();
  });
  function updateClip() {
    const px = state.divX * stage.clientWidth;
    divider.style.left = px + "px";
    document.documentElement.style.setProperty("--divx", px + "px");
  }
  // divider drag
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => { dragging = true; divider.setPointerCapture(e.pointerId); });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.divX = Math.max(0.05, Math.min(0.95, e.clientX / stage.clientWidth));
    updateClip();
  });
  divider.addEventListener("pointerup", () => { dragging = false; });

  // ---------------------------------------------------------------- inspect
  const inspectEl = $("#inspect");
  let gtip = document.createElement("div");
  gtip.className = "panel"; gtip.style.cssText = "position:fixed;z-index:31;padding:7px 10px;display:none;pointer-events:none;font:500 11px 'IBM Plex Mono',monospace;";
  document.body.appendChild(gtip);

  cv.stations.addEventListener("mousemove", (e) => {
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // nearest station within 10px
    let best = null, bd = 11 * 11;
    for (const s of WP.STATIONS) {
      const dx = proj.x(s.lon) - mx, dy = proj.y(s.lat) - my;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      if (state.hoverStation !== best.id) { state.hoverStation = best.id; needStations = true; render(); }
      const v = state.month != null ? best.monthly[state.month] : best.annual / 12;
      gtip.innerHTML = `<b style="font:600 12px 'IBM Plex Sans'">${best.name}</b> <span style="color:var(--sepia)">${best.country}</span><br>${v} mm · ${MONTHS[state.month]}`;
      gtip.style.display = "block";
      gtip.style.left = Math.min(e.clientX + 14, window.innerWidth - 160) + "px";
      gtip.style.top = (e.clientY + 14) + "px";
      cv.stations.style.cursor = "pointer";
    } else {
      if (state.hoverStation !== null) { state.hoverStation = null; needStations = true; render(); }
      gtip.style.display = "none";
      cv.stations.style.cursor = "crosshair";
    }
  });
  cv.stations.addEventListener("mouseleave", () => { gtip.style.display = "none"; if (state.hoverStation !== null) { state.hoverStation = null; needStations = true; } });

  cv.stations.addEventListener("click", (e) => {
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const lon = proj.lon(mx), lat = proj.lat(my);
    if (state.tool === "drop") { dropGauge(lon, lat); return; }
    if (state.tool === "transect") { transectClick(lon, lat); return; }
    const info = WP.inspect(lon, lat, { month: state.month, power: state.power, radiusDeg: state.radius, interp, trend: state.trend });
    showInspect(info, e.clientX, e.clientY);
  });

  function showInspect(info, cx, cy) {
    const rainTxt = isNaN(info.rain) ? "—" : Math.round(info.rain) + " mm";
    const anomTxt = (info.anom >= 0 ? "+" : "") + Math.round(info.anom * 100) + "%";
    let kColor = "rgba(70,240,160,0.10)", kInk = "var(--ink-soft)";
    if (info.klass === "Wet pocket") { kColor = "rgba(25,215,230,0.18)"; kInk = "#7af0ff"; }
    if (info.klass === "Dry pocket") { kColor = "rgba(255,61,127,0.18)"; kInk = "#ff8db4"; }
    let contribHtml = "";
    if (info.contribs.length && !isNaN(info.rain)) {
      contribHtml = `<div class="contribs"><div class="ch">TOP GAUGE WEIGHTS</div>` +
        info.contribs.map((c) => `<div class="crow"><span class="cbar" style="width:${Math.max(6, c.share * 70)}px"></span><span class="cn">${c.st.name}</span><span style="color:var(--sepia)">${Math.round(c.share * 100)}%</span></div>`).join("") +
        `</div>`;
    }
    inspectEl.innerHTML =
      `<h3>${info.inBasin ? "Basin cell" : "Outside basin"}</h3>` +
      `<div class="coord">${Math.abs(info.lat).toFixed(2)}°${info.lat >= 0 ? "N" : "S"}, ${Math.abs(info.lon).toFixed(2)}°W</div>` +
      `<div class="metric"><span>Interpolated rain</span><b style="color:var(--rain)">${rainTxt}</b></div>` +
      `<div class="metric"><span>vs basin mean</span><b style="color:${info.anom < 0 ? 'var(--dry)' : 'var(--green)'}">${anomTxt}</b></div>` +
      `<div class="metric"><span>Forest cover</span><b style="color:var(--green)">${Math.round(info.forest * 100)}%</b></div>` +
      `<div class="metric"><span>Air temp</span><b style="color:var(--ochre)">${info.temp.toFixed(1)}°C</b></div>` +
      `<div class="klass" style="background:${kColor};color:${kInk}">${info.klass}</div>` +
      `<div class="metric" style="font-size:10px;color:var(--ink-soft)"><span>${info.ngauges} gauges within radius</span></div>` +
      contribHtml;
    inspectEl.style.display = "block";
    const w = 232, h = inspectEl.offsetHeight;
    inspectEl.style.left = Math.min(cx + 16, window.innerWidth - w - 12) + "px";
    inspectEl.style.top = Math.min(Math.max(12, cy - h / 2), window.innerHeight - h - 12) + "px";
  }
  // dismiss inspect on outside click
  document.addEventListener("click", (e) => {
    if (!inspectEl.contains(e.target) && e.target !== cv.stations) inspectEl.style.display = "none";
  });

  // ---------------------------------------------------------------- priority
  function regionScore(r) {
    // sample the field model within the region disc
    let n = 0, fSum = 0, tSum = 0, anomSum = 0;
    const step = 0.5;
    for (let dlon = -r.r; dlon <= r.r; dlon += step) {
      for (let dlat = -r.r; dlat <= r.r; dlat += step) {
        if (dlon * dlon + dlat * dlat > r.r * r.r) continue;
        const lon = r.lon + dlon, lat = r.lat + dlat;
        const f = WP.forestAt(lon, lat), t = WP.tempAt(lon, lat);
        const rain = WP.monthlyRainModel(lon, lat, state.month) * (1 - state.trend * (0.10 + (1 - f) * 0.40));
        const anom = interp && interp.basinMean ? (rain - interp.basinMean) / interp.basinMean : 0;
        fSum += f; tSum += t; anomSum += anom; n++;
      }
    }
    const f = fSum / n, t = tSum / n, anom = anomSum / n;
    if (r.kind === "protect") {
      // value = wet + intact + cool
      return Math.round((f * 50 + Math.max(0, anom) * 80 + Math.max(0, 29 - t) * 6));
    }
    // risk = cleared + hot + dry
    return Math.round(((1 - f) * 55 + Math.max(0, t - 28) * 6 + Math.max(0, -anom) * 90));
  }
  function updatePriority() {
    const list = $("#regionList");
    const scored = WP.REGIONS.map((r) => ({ r, s: regionScore(r) }));
    // rank risks descending, then protect items
    const risks = scored.filter((x) => x.r.kind === "risk").sort((a, b) => b.s - a.s);
    const prot = scored.filter((x) => x.r.kind === "protect").sort((a, b) => b.s - a.s);
    const ordered = risks.concat(prot);
    list.innerHTML = ordered.map((x, i) => {
      const r = x.r;
      const rk = r.kind === "risk" ? (i + 1) : "★";
      return `<div class="region ${r.kind}${state.selRegion === r.id ? ' open' : ''}" data-id="${r.id}">
        <div class="rtop"><span class="rank">${rk}</span><span class="rname">${r.name}</span><span class="score">${x.s}</span></div>
        <div class="resp">→ ${r.response}</div>
        <div class="why">${r.desc}</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".region").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        state.selRegion = state.selRegion === id ? null : id;
        el.classList.toggle("open");
        list.querySelectorAll(".region").forEach((o) => { if (o !== el) o.classList.remove("open"); });
        needStations = true; render();
      });
      el.addEventListener("mouseenter", () => { state.selRegion = el.dataset.id; needStations = true; render(); });
    });
    $("#regionList").addEventListener("mouseleave", () => {
      if (!list.querySelector(".region.open")) { state.selRegion = null; needStations = true; render(); }
    }, { once: true });
  }

  // ---------------------------------------------------------------- legend
  function rampCss(name) {
    const stops = WP.RAMPS[name];
    return "linear-gradient(90deg," + stops.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(",") + ")";
  }
  function updateLegend() {
    const lt = $("#legTitle"), bar = $("#legBar"), mn = $("#legMin"), mx = $("#legMax");
    if (state.base === "forest") { lt.textContent = "Forest cover"; bar.style.background = rampCss("FOREST"); mn.textContent = "cleared"; mx.textContent = "intact"; }
    else if (state.base === "temp") { lt.textContent = "Air temperature (°C)"; bar.style.background = rampCss("TEMP"); mn.textContent = WP.TEMP_DOMAIN[0]; mx.textContent = WP.TEMP_DOMAIN[1] + "+"; }
    else if (state.base === "conf") { lt.textContent = "Interpolation confidence"; bar.style.background = rampCss("CONF"); mn.textContent = "a guess"; mx.textContent = "well sampled"; }
    else { lt.textContent = state.base === "none" ? "Detected pockets" : "Monthly rainfall (mm)"; bar.style.background = rampCss("RAIN"); mn.textContent = WP.RAIN_DOMAIN[0]; mx.textContent = WP.RAIN_DOMAIN[1] + "+"; }
  }

  // ---------------------------------------------------------------- overlays
  $("#aboutBtn").addEventListener("click", () => $("#intro").classList.add("show"));
  $("#methodBtn").addEventListener("click", () => $("#method").classList.add("show"));
  $("#introStart").addEventListener("click", () => { $("#intro").classList.remove("show"); localStorage.setItem("wp_seen", "1"); });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => $("#" + b.dataset.close).classList.remove("show")));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));

  // intro mini illustrations
  function drawIntro() {
    const B = WP.BOUNDS;
    const sub = { lonMin: -75, lonMax: -45, latMin: -16, latMax: 4 }; // basin-ish crop
    function mini(canvas, surface) {
      const ctx = canvas.getContext("2d");
      const W = canvas.width, H = canvas.height;
      ctx.fillStyle = "#e7dcc2"; ctx.fillRect(0, 0, W, H);
      const px = (lon) => ((lon - sub.lonMin) / (sub.lonMax - sub.lonMin)) * W;
      const py = (lat) => ((sub.latMax - lat) / (sub.latMax - sub.latMin)) * H;
      if (surface) {
        const gw = 70, gh = 46;
        const img = ctx.createImageData(gw, gh);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          const lon = sub.lonMin + (x / gw) * (sub.lonMax - sub.lonMin);
          const lat = sub.latMax - (y / gh) * (sub.latMax - sub.latMin);
          const v = WP.monthlyRainModel(lon, lat, 7); // August (dry season)
          const c = colRamp(WP.RAMPS.RAIN, (v - 30) / 330);
          const o = (y * gw + x) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 230;
        }
        const buf = document.createElement("canvas"); buf.width = gw; buf.height = gh;
        buf.getContext("2d").putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true; ctx.drawImage(buf, 0, 0, W, H);
        // dry pocket ring illustration
        ctx.strokeStyle = "rgba(214,41,107,0.95)"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.ellipse(px(-56), py(-11), 26, 16, 0.3, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      }
      // stations
      for (const s of WP.STATIONS) {
        if (s.lon < sub.lonMin || s.lon > sub.lonMax || s.lat < sub.latMin || s.lat > sub.latMax) continue;
        const x = px(s.lon), y = py(s.lat);
        if (surface) { ctx.fillStyle = "rgba(34,28,16,0.85)"; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); }
        else {
          const v = s.monthly[7];
          const c = colRamp(WP.RAMPS.RAIN, (v - 30) / 330);
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = "rgba(40,32,18,0.7)"; ctx.stroke();
        }
      }
    }
    function colRamp(stops, t) {
      t = Math.max(0, Math.min(1, t));
      const seg = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), f = seg - i;
      return [stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f, stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f, stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f];
    }
    mini($("#introA"), false);
    mini($("#introB"), true);
  }

  // ---------------------------------------------------------------- LOO + tools
  function updateLoo(loo) {
    const el = $("#looVal"); if (!el) return;
    el.textContent = loo && !isNaN(loo.rmse) ? Math.round(loo.rmse) + " mm" : "—";
  }

  // tool arming (drop-gauge / transect)
  function setTool(t) {
    state.tool = (state.tool === t) ? "inspect" : t;
    $("#dropBtn").classList.toggle("armed", state.tool === "drop");
    $("#transectBtn").classList.toggle("armed", state.tool === "transect");
    cv.stations.style.cursor = state.tool === "inspect" ? "crosshair" : "copy";
    if (state.tool !== "transect") { transectPts = []; }
    inspectEl.style.display = "none";
  }
  $("#dropBtn").addEventListener("click", () => setTool("drop"));
  $("#transectBtn").addEventListener("click", () => { setTool("transect"); if (state.tool === "transect") { transectPts = []; $("#transectPanel").classList.remove("show"); } });

  // drop a hypothetical gauge: value sampled from the current surface; confidence
  // and the surface then recompute, so the user sees how a new station helps.
  let dropCount = 0;
  function dropGauge(lon, lat) {
    if (!WP.inBasin(lon, lat)) { setDataHint("Drop gauges inside the basin."); return; }
    // sample the current IDW surface at this point only (pointwise, cheap)
    const st = WP.STATIONS, r2 = state.radius * state.radius, pw = state.power;
    const monthly = [];
    for (let m = 0; m < 12; m++) {
      let num = 0, den = 0;
      for (let i = 0; i < st.length; i++) {
        const dx = lon - st[i].lon, dy = lat - st[i].lat, d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 1e-9) continue;
        const w = 1 / Math.pow(d2, pw / 2);
        num += w * st[i].monthly[m]; den += w;
      }
      monthly.push(den > 0 ? Math.round(num / den) : 120);
    }
    const annual = monthly.reduce((a, b) => a + b, 0);
    WP.STATIONS.push({ id: WP.STATIONS.length, name: "New gauge " + (++dropCount), country: "+",
      lon, lat, annual, monthly, tempMonthly: monthly.map(() => WP.tempAt(lon, lat)), forest: WP.forestAt(lon, lat), temp: WP.tempAt(lon, lat), dropped: true });
    gaugeStamp++;
    needField = true; needStations = true; render();
    setDataHint(dropCount + " gauge(s) added. Switch to the Confidence layer to see coverage improve.");
  }

  // transect: two clicks define a line; sample + draw a profile chart
  let transectPts = [];
  function transectClick(lon, lat) {
    transectPts.push([lon, lat]);
    if (transectPts.length === 2) { drawTransect(); setTool("inspect"); }
    else { setDataHint("Click a second point to complete the transect."); }
    needStations = true; render();
  }
  function drawTransect() {
    const data = WP.sampleTransect(transectPts[0], transectPts[1], interp, 90);
    $("#transectPanel").classList.add("show");   // show first so the canvas has width
    const cv2 = $("#transectChart"), ctx = cv2.getContext("2d");
    const w = cv2.clientWidth || 520;
    cv2.width = w * DPR; cv2.height = 110 * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const h = 110;
    ctx.clearRect(0, 0, w, h);
    const pad = 6;
    const line = (key, color, lo, hi) => {
      ctx.beginPath();
      data.forEach((d, i) => {
        const x = pad + (w - 2 * pad) * (i / (data.length - 1));
        let v = d[key]; if (v == null || isNaN(v)) v = lo;
        const y = h - pad - (h - 2 * pad) * Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    };
    line("rain", "#3a7ca8", 0, 360);
    line("forest", "#2b7a46", 0, 1);
    line("temp", "#c0683a", 21, 32);
    $("#transectPanel").classList.add("show");
  }
  $("#transectClose").addEventListener("click", () => { $("#transectPanel").classList.remove("show"); transectPts = []; needStations = true; render(); });

  // guided tour
  let tourStep = -1;
  function tourGo(i) {
    const steps = WP.TOUR; if (i < 0 || i >= steps.length) { tourEnd(); return; }
    tourStep = i; const s = steps[i];
    // apply state
    if (s.state.base) { state.base = s.state.base; $("#baseSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.base === state.base)); updateLegend(); needField = true; needGeo = true; }
    if (s.state.month != null && state.month !== s.state.month) { state.month = s.state.month; if (state.mode !== "season") switchMode("season"); syncSlider(); needField = true; }
    if (s.state.pockets != null) { state.ov.pockets = s.state.pockets; setOv("pockets", s.state.pockets); }
    if (s.state.flow != null) { state.ov.flow = s.state.flow; setOv("flow", s.state.flow); }
    if (s.state.compare === false && state.compare) $("#cmpBtn").click();
    render();
    $("#tourNum").textContent = "Step " + (i + 1) + " / " + steps.length;
    $("#tourTitle").textContent = s.title;
    $("#tourBody").textContent = s.body;
    $("#tourDots").innerHTML = steps.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("");
    $("#tourNext").textContent = i === steps.length - 1 ? "Finish" : "Next →";
    $("#tourCard").classList.add("show");
  }
  function setOv(k, on) {
    const t = document.querySelector('.toggle[data-ov="' + k + '"]');
    if (t) t.classList.toggle("on", on);
    if (k === "flow" && !on) clear(cv.flow);
  }
  function tourEnd() { tourStep = -1; $("#tourCard").classList.remove("show"); }
  $("#tourBtn").addEventListener("click", () => tourGo(0));
  $("#tourNext").addEventListener("click", () => tourGo(tourStep + 1));
  $("#tourExit").addEventListener("click", tourEnd);

  // ---------------------------------------------------------------- boot
  function boot() {
    cache = WP.cacheFields(GW, GH);
    resize();
    WP.flowInit();
    switchMode("season");
    updateLegend();
    drawIntro();
    if (!localStorage.getItem("wp_seen")) $("#intro").classList.add("show");
    loop();        // immediate first paint (does not depend on rAF)
    startLoop();   // continuous animation (rAF + timer watchdog)

    // Robust first paint: the stage may have zero layout when boot() runs.
    // Re-run resize()+render() once it has real dimensions — via ResizeObserver,
    // window 'load', and a few timed retries — so the map never sits blank.
    function ensureDrawn() {
      if (stage.clientWidth && stage.clientHeight) {
        if (cv.field.width !== Math.round(stage.clientWidth * DPR)) resize();
        else render();
        hideLoader();
        return true;
      }
      return false;
    }
    // Fade the loading screen once the map has actually painted (brief min hold
    // so the atlas intro animation reads), with a hard fallback so it never sticks.
    let loaderGone = false;
    function hideLoader() {
      if (loaderGone) return; loaderGone = true;
      const el = document.getElementById("loader"); if (!el) return;
      setTimeout(() => { el.classList.add("hide"); setTimeout(() => el.remove(), 700); }, 500);
    }
    setTimeout(hideLoader, 3000); // safety net
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (ensureDrawn()) {/* keep observing for later resizes */} });
      ro.observe(stage);
    }
    window.addEventListener("load", ensureDrawn);
    [0, 60, 200, 500, 1200].forEach((ms) => setTimeout(ensureDrawn, ms));
  }
  boot();

})();
