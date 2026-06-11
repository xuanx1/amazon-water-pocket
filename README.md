# Wet Pockets

An interactive ecological-recon map that interpolates sparse Amazon rain gauges into a
continuous surface to reveal **wet pockets** (the forest's moisture-recycling cores) and
emerging **dry pockets** (where clearing is breaking the rain cycle).

> **Thesis** — the rainforest makes much of its own rain through evapotranspiration
> ("flying rivers"). Where the canopy is cleared, dry pockets open up that interpolation can
> expose before they spread.

---

## Open it

Open **`Wet Pockets.html`** (project root) in any modern browser. It is a single, fully
self-contained file — all JavaScript, fonts, and data are inlined, so it works offline with
zero external requests.

---

## What's real vs. modelled

| Layer | Source | Status |
|---|---|---|
| **Rainfall** (monthly, per station) | ERA5 reanalysis via the Open-Meteo Historical Weather API, 2021–2023 climatology | **Real observations** |
| **Air temperature** | ERA5 reanalysis via Open-Meteo, same period | **Real observations** |
| **Coastline & national borders** | Natural Earth 1:50m (johan/world.geo.json + French Guiana) | **Real vectors** |
| **River network** | Natural Earth ne_50m rivers, clipped to the basin | **Real vectors** |
| **Amazon basin divide** | HydroSHEDS HydroBASINS level-3 (Douglas–Peucker simplified) | **Real hydrological divide** |
| **Forest cover** | Deforestation-arc model (no open point source was wired) | **Modelled / illustrative** |
| **Pocket detection, drying-trend slider** | Composite scoring layered on the above | **Illustrative model** |

This is a **teaching tool**, not a climate or land-use study.

---

## Features

- **Live interpolation** — IDW (adjustable power + search radius) or ordinary kriging
  (adjustable range + nugget); the surface recomputes as you tune it.
- **Wet / dry pocket detection** — pulsing cyan/magenta iso-contours combining interpolated
  rainfall anomaly, forest cover, and surface temperature.
- **Flying rivers** — animated moisture streamlines following a trade-wind + Andes-recurve
  flux field, thinning over rainfall deficits.
- **Season & multi-year drying playback**, **compare swipe** (gauges-only vs. surface).
- **Confidence layer** — where the interpolation is well-sampled vs. a guess.
- **Leave-one-out cross-validation** — live RMSE skill score for the current method/params.
- **Tools** — drop hypothetical gauges, draw a transect profile, take the guided tour.
- **Import your own gauges** — CSV with `name, lon, lat` + `annual` or `jan…dec`.

---

## Project structure

```
Wet Pockets.html         ← the deliverable (self-contained, open this)
wetpockets/              ← editable source
  Wet Pockets.html         page shell (markup + styles); references the JS modules below
  geo.js                   baked geography: basin divide, country rings, rivers, labels
  climate.js               baked ERA5 monthly rainfall + temperature per station
  data.js                  stations, ecological field models, sub-regions
  interp.js                projection, IDW + kriging, pocket classification, contours
  features.js              confidence grid, leave-one-out CV, transect, guided tour
  render.js                canvas rendering (field, geography, stations, pockets, labels)
  flow.js                  flying-rivers particle simulation
  app.js                   state, controls, playback, tools, orchestration
  fonts-embedded.css       base64 IBM Plex Sans/Mono (offline)
uploads/                 ← raw source data used to bake geo.js / climate.js (provenance)
```

## Rebuilding the single file

Edit the modules in `wetpockets/`, then inline them into the root `Wet Pockets.html`:
embed `fonts-embedded.css` in place of the Google Fonts `<link>`, and replace the
`<script src="…">` tags with the module contents inlined in order
(geo → climate → data → interp → features → render → flow → app).
