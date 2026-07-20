# XCS → DXF Converter

Free, in-browser converter for xTool Creative Space `.xcs` project files to **DXF** —
with the laser operation types (surface engraving, line engraving, line cutting)
preserved as separate colours. Files never leave your computer.

Based on [XCStoSVG by Daniel Nanovski](https://nanovsky.github.io/XCStoSVG/) —
maintained by [bbraeu](https://github.com/bbraeu/XCStoDXF).

## How it works

- `.xcs` files are plain JSON. Geometry lives in `canvas[].displays[]`; the
  operation type per shape lives in `device.data.value` (a serialised Map of
  `displayId → processingType`).
- Shapes are rendered into an off-screen SVG (reusing the preview builders),
  positioned via the browser's `getCTM()`, and bezier curves are adaptively
  flattened to polylines at 0.01 mm.
- The DXF writer emits `LWPOLYLINE`s on a single layer, coloured by operation
  (ACI): blue = surface engraving, green = line engraving, red = cutting.
  Colours (not layers) are used because Falcon Design Space rearranges separate
  DXF layers on import.

## Stack

[Astro](https://astro.build) + React (converter island) + Tailwind CSS v4,
written in TypeScript. Deployed to GitHub Pages via `.github/workflows/static.yml`.

## Development

```sh
pnpm install
pnpm dev       # local dev server
pnpm check     # typecheck (astro check)
pnpm build     # production build to dist/
```

Sample projects for testing live in `template/`.
