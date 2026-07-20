// Falcon Design Space (.fds) project writer.
//
// Reverse-engineered from projects saved by Falcon Design Space (Qt app):
// an .fds file is a sequence of three blocks, each laid out as
//   [u32 LE blockLength][u32 BE uncompressedSize][zlib deflate stream]
// (the inner part is exactly Qt's qCompress format). Every block holds compact
// JSON:
//   block 1: device + material metadata
//   block 2: { defaultMaterial, layers[], shapes[] }   <- the design
//   block 3: crystal-engrave parameters
//
// Shapes carry a QPainterPath serialisation: path nodes {p:{x,y}, t} with
// t = 0 MoveTo, 1 LineTo, 2 CurveTo (1st control), 3 CurveToData — plus a
// QTransform. Coordinates are millimetres, y grows downwards.
//
// Layers carry the laser operation via `mode`:
//   0 = fill/surface engraving, 1 = line engraving, 2 = line cutting.
// Cutting layers have air assist enabled (air: true), matching the reference
// project. This is the key advantage over DXF import, which collapses every
// layer to line engraving.

import { FDS_TEMPLATE_B64 } from "./fds-template";
import type { Subpath } from "./dxf";

/** xcs processingType -> FDS layer mode */
export const FDS_MODES: Record<string, number> = {
    FILL_VECTOR_ENGRAVING: 0,
    BITMAP_ENGRAVING: 0,
    VECTOR_ENGRAVING: 1,
    VECTOR_CUTTING: 2,
    KNIFE_CUTTING: 2
};

export const getFdsModeFor = (processingType: string | undefined): number =>
    (processingType ? FDS_MODES[processingType] : undefined) ?? 1;

// Colours as used by Falcon Design Space's default layer palette.
const MODE_META: Record<number, { color: string; air: boolean }> = {
    0: { color: "#2196f3", air: false }, // surface engraving
    1: { color: "#00e000", air: false }, // line engraving
    2: { color: "#000000", air: true }   // line cutting (air assist on)
};

export interface FdsShapeInput {
    /** FDS layer mode (see FDS_MODES) */
    mode: number;
    /** all subpaths of one design object, in mm, y-down */
    subpaths: Subpath[];
}

interface FdsTemplate {
    block1: unknown;
    block3: unknown;
    defaultMaterial: unknown;
    layerTemplate: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Template loading (compressed reference data, decoded once)
// ---------------------------------------------------------------------------

const base64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64),
        out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

let templatePromise: Promise<FdsTemplate> | null = null;
const loadTemplate = (): Promise<FdsTemplate> => {
    templatePromise ??= inflate(base64ToBytes(FDS_TEMPLATE_B64))
        .then(bytes => JSON.parse(new TextDecoder().decode(bytes)) as FdsTemplate);
    return templatePromise;
};

// ---------------------------------------------------------------------------
// Design (block 2) construction
// ---------------------------------------------------------------------------

const round = (n: number): number => Math.round(n * 1000) / 1000;

interface FdsPathNode {
    p: { x: number; y: number };
    t: number;
}

const toPathNodes = (subpaths: Subpath[]): FdsPathNode[] => {
    const nodes: FdsPathNode[] = [];
    for (const sub of subpaths) {
        if (sub.points.length < 2) continue;
        sub.points.forEach((p, i) => {
            nodes.push({ p: { x: round(p.x), y: round(p.y) }, t: i === 0 ? 0 : 1 });
        });
        if (sub.closed) {
            const first = sub.points[0]!,
                last = sub.points[sub.points.length - 1]!;
            if (first.x !== last.x || first.y !== last.y) {
                nodes.push({ p: { x: round(first.x), y: round(first.y) }, t: 1 });
            }
        }
    }
    return nodes;
};

// ---------------------------------------------------------------------------
// Binary assembly
// ---------------------------------------------------------------------------

const encodeBlock = async (json: unknown): Promise<Uint8Array> => {
    const raw = new TextEncoder().encode(JSON.stringify(json)),
        compressed = await deflate(raw),
        // qCompress payload: u32 BE uncompressed size + zlib stream
        qc = new Uint8Array(4 + compressed.length);
    new DataView(qc.buffer).setUint32(0, raw.length, false);
    qc.set(compressed, 4);
    // block: u32 LE length prefix + qCompress payload
    const block = new Uint8Array(4 + qc.length);
    new DataView(block.buffer).setUint32(0, qc.length, true);
    block.set(qc, 4);
    return block;
};

/** Build a complete .fds project file from design shapes. */
export const buildFds = async (shapes: FdsShapeInput[]): Promise<Blob> => {
    const tpl = await loadTemplate();

    // One layer per operation mode actually used, in FDS default order.
    const modes = [0, 1, 2].filter(m => shapes.some(s => s.mode === m));
    const layers = modes.map((mode, i) => {
        const id = String(i).padStart(2, "0");
        return {
            ...tpl.layerTemplate,
            layer: id,
            name: id,
            mode,
            color: MODE_META[mode]!.color,
            air: MODE_META[mode]!.air
        };
    });

    const fdsShapes = shapes
        .map(s => ({ shape: s, path: toPathNodes(s.subpaths) }))
        .filter(x => x.path.length > 1)
        .map(({ shape, path }) => ({
            leftdownRadius: 0,
            leftupRadius: 0,
            rightdownRadius: 0,
            rightupRadius: 0,
            shape: {
                cornerRadius: 0,
                cutOrder: 0,
                edgesNum: 6,
                isLocked: false,
                layerIndex: modes.indexOf(shape.mode),
                path,
                power: 100,
                radius: 0,
                rect: { h: 0, w: 0, x: 0, y: 0 },
                transform: { dx: 0, dy: 0, m11: 1, m12: 0, m21: 0, m22: 1 },
                type: "Custom"
            }
        }));

    const block2 = {
        defaultMaterial: tpl.defaultMaterial,
        layers,
        shapes: fdsShapes
    };

    const blocks = await Promise.all([
        encodeBlock(tpl.block1),
        encodeBlock(block2),
        encodeBlock(tpl.block3)
    ]);

    return new Blob(blocks as BlobPart[], { type: "application/octet-stream" });
};
