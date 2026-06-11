# Wet Pockets

An interactive ecological-recon map that interpolates sparse Amazon rain gauges into a continuous surface to reveal **wet pockets** (the forest's moisture-recycling cores) and emerging **dry pockets** (where clearing is breaking the rain cycle).

> **Thesis** — the rainforest makes much of its own rain through evapotranspiration
> ("flying rivers"). Where the canopy is cleared, dry pockets open up that interpolation can
> expose before they spread.


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