# XToolConverter

**Live: [bbraeu.github.io/XToolConverter](https://bbraeu.github.io/XToolConverter/)**

Free, in-browser converter for xTool project files — both xTool Creative Space
`.xcs` and xTool Studio `.xs` — with the laser operation types (surface
engraving, line engraving, line cutting) preserved. Files never leave your
computer.

Successor of [XCStoDXF](https://github.com/bbraeu/XCStoDXF), based on
[XCStoSVG by Daniel Nanovski](https://nanovsky.github.io/XCStoSVG/) —
maintained by [bbraeu](https://github.com/bbraeu).

## Input formats

| Format | App | Notes |
| --- | --- | --- |
| **.xcs** | xTool Creative Space | plain JSON project file |
| **.xs** | xTool Studio | ZIP archive (`xcs-workspace-v2`) holding the same model split into parts |

## Output formats

| Format | Operations | Notes |
| --- | --- | --- |
| **DXF** (default) | colour-coded (ACI) | AutoCAD R2000, single layer, read by LightBurn / Fusion / any CAM tool |
| **FDS** | natively assigned layers | Falcon Design Space project — engrave & cut modes pre-assigned on import |
| **SVG** | colour-coded strokes/fills | Exactly what the preview shows |

## How it works

- `.xcs` files are plain JSON. Geometry lives in `canvas[].displays[]`; the
  operation type per shape lives in `device.data.value` (a serialised Map of
  `displayId → processingType`).
- `.xs` files (xTool Studio) are ZIP archives with the same model split into
  parts: `canvases/<id>/displays-<n>.json` (geometry, chunked),
  `vectors/<bucket>/data-<n>.json` (deduplicated `dPath` strings referenced via
  `vectorRef`), `profiles.json` (profile → `processingType`) and
  `devices/device-<id>.json` (bindings: profile → display ids).
  `src/lib/xs.ts` reassembles them into the `.xcs` shape, so the rest of the
  pipeline is shared.
- Shapes are rendered into an off-screen SVG (reusing the preview builders),
  positioned via the browser's `getCTM()`, and bezier curves are adaptively
  flattened to polylines at 0.01 mm.
- **DXF**: `LWPOLYLINE`s on a single layer, coloured by operation (ACI):
  blue = surface engraving, green = line engraving, red = cutting. Colours
  (not layers) are used because Falcon Design Space rearranges separate DXF
  layers on import.
- **FDS**: the native Falcon Design Space container — blocks of
  `[u32 LE length][u32 BE raw size][zlib]` (Qt `qCompress`) holding JSON with
  QPainterPath-style geometry. Operation modes: 0 = surface engraving,
  1 = line engraving, 2 = line cutting (air assist on).

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
