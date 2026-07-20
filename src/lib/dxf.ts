// DXF generation helpers: SVG-path flattening + a minimal AutoCAD R2000 (AC1015) writer.
//
// The .xcs geometry is stored as SVG path data (cubic/quadratic beziers, arcs).
// DXF has no universally-imported curve primitive that every laser tool reads, so we
// flatten curves to polylines at a very fine tolerance (well below the laser spot),
// which is exact for practical purposes and read by every Creality/LightBurn version.

export interface Point {
    x: number;
    y: number;
}

export interface Subpath {
    points: Point[];
    closed: boolean;
}

export interface DxfEntity {
    /** AutoCAD Color Index conveying the operation type */
    color: number;
    points: Point[];
    closed: boolean;
}

export interface Operation {
    name: string;
    /** AutoCAD Color Index used in the DXF output */
    color: number;
    /** CSS colour used for the on-screen SVG preview */
    css: string;
}

/** Chord tolerance for curve flattening, in millimetres (xcs units are mm). */
export const FLATTEN_TOLERANCE = 0.01;

// Map an xcs processingType to an AutoCAD Color Index (ACI). Laser software
// (Falcon Design Space, LightBurn, xTool …) groups a DXF into operations by
// COLOR, so we keep all geometry on a single layer and colour each entity by its
// operation type. Emitting separate DXF layers instead makes Falcon rearrange
// them on import, which is why colours are used rather than layers.
export const OPERATION_COLORS: Record<string, Operation> = {
    FILL_VECTOR_ENGRAVING: { name: "Surface Engraving", color: 5, css: "#1e6bff" }, // blue
    VECTOR_ENGRAVING:      { name: "Line Engraving",    color: 3, css: "#00a000" }, // green
    VECTOR_CUTTING:        { name: "Line Cutting",      color: 1, css: "#ff0000" }, // red
    KNIFE_CUTTING:         { name: "Knife Cutting",     color: 6, css: "#c000c0" }, // magenta
    BITMAP_ENGRAVING:      { name: "Bitmap Engraving",  color: 2, css: "#c0a000" }  // yellow
};

const DEFAULT_OPERATION: Operation = { name: "Other", color: 7, css: "#000000" }; // black

export const getOperationFor = (processingType: string | undefined): Operation =>
    (processingType && OPERATION_COLORS[processingType]) || DEFAULT_OPERATION;

// ---------------------------------------------------------------------------
// SVG path flattening
// ---------------------------------------------------------------------------

// Recursive de Casteljau subdivision of a cubic bezier until it is flat to `tol`.
const flattenCubic = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number,
    tol: number, out: Point[], depth = 0
): void => {
    // Flatness: max distance of the two control points from the chord p0-p3.
    const dx = x3 - x0,
        dy = y3 - y0,
        d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx),
        d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx),
        chord = dx * dx + dy * dy;

    if (depth > 24 || (d1 + d2) * (d1 + d2) <= tol * tol * chord) {
        out.push({ x: x3, y: y3 });
        return;
    }

    // Subdivide at t = 0.5.
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2,
        x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2,
        x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2,
        xa = (x01 + x12) / 2, ya = (y01 + y12) / 2,
        xb = (x12 + x23) / 2, yb = (y12 + y23) / 2,
        xm = (xa + xb) / 2, ym = (ya + yb) / 2;

    flattenCubic(x0, y0, x01, y01, xa, ya, xm, ym, tol, out, depth + 1);
    flattenCubic(xm, ym, xb, yb, x23, y23, x3, y3, tol, out, depth + 1);
};

const flattenQuadratic = (
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    tol: number, out: Point[]
): void => {
    // Elevate quadratic to cubic and reuse the cubic flattener.
    const c1x = x0 + (2 / 3) * (x1 - x0), c1y = y0 + (2 / 3) * (y1 - y0),
        c2x = x2 + (2 / 3) * (x1 - x2), c2y = y2 + (2 / 3) * (y1 - y2);
    flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x2, y2, tol, out);
};

// Flatten an SVG elliptical arc (endpoint parameterisation) into line segments.
const flattenArc = (
    x0: number, y0: number, rx: number, ry: number, xAxisDeg: number,
    largeArc: number, sweep: number, x: number, y: number,
    tol: number, out: Point[]
): void => {
    if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
        out.push({ x, y });
        return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (xAxisDeg * Math.PI) / 180,
        cosP = Math.cos(phi),
        sinP = Math.sin(phi),
        dx2 = (x0 - x) / 2,
        dy2 = (y0 - y) / 2,
        x1p = cosP * dx2 + sinP * dy2,
        y1p = -sinP * dx2 + cosP * dy2;

    // Correct out-of-range radii.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }

    const sign = largeArc !== sweep ? 1 : -1,
        num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p,
        den = rx * rx * y1p * y1p + ry * ry * x1p * x1p,
        co = sign * Math.sqrt(Math.max(0, num / den)),
        cxp = (co * rx * y1p) / ry,
        cyp = (-co * ry * x1p) / rx,
        cx = cosP * cxp - sinP * cyp + (x0 + x) / 2,
        cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number): number => {
        const dot = ux * vx + uy * vy,
            len = Math.hypot(ux, uy) * Math.hypot(vx, vy),
            a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
        return ux * vy - uy * vx < 0 ? -a : a;
    };

    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);

    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

    // Segment count based on radius and tolerance.
    const rMax = Math.max(rx, ry),
        segs = Math.max(2, Math.ceil(Math.abs(dTheta) / (2 * Math.acos(Math.max(0, 1 - tol / rMax)))));
    for (let i = 1; i <= segs; i++) {
        const t = theta1 + (dTheta * i) / segs,
            ex = cosP * rx * Math.cos(t) - sinP * ry * Math.sin(t) + cx,
            ey = sinP * rx * Math.cos(t) + cosP * ry * Math.sin(t) + cy;
        out.push({ x: ex, y: ey });
    }
};

// Tokenise a path `d` string into [command, ...numbers] groups.
const tokenizePath = (d: string): (string | number)[] => {
    const tokens: (string | number)[] = [],
        re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(d)) !== null) {
        tokens.push(m[1] !== undefined ? m[1] : parseFloat(m[2]!));
    }
    return tokens;
};

// Parse an SVG path `d` string into an array of subpaths.
export const parsePathToPolylines = (d: string | undefined | null, tol: number = FLATTEN_TOLERANCE): Subpath[] => {
    if (!d) return [];
    const tokens = tokenizePath(d),
        subpaths: Subpath[] = [];
    let i = 0,
        cur: Subpath | null = null, // current subpath being built
        cx = 0, cy = 0,             // current point
        sx = 0, sy = 0,             // subpath start
        prevCx = 0, prevCy = 0,     // previous cubic control (for S/s)
        prevQx = 0, prevQy = 0,     // previous quad control (for T/t)
        cmd: string | null = null,
        prevCmd: string | null = null;

    const num = (): number => tokens[i++] as number;
    const startSub = (x: number, y: number): Subpath => {
        const sub: Subpath = { points: [{ x, y }], closed: false };
        subpaths.push(sub);
        sx = x;
        sy = y;
        return sub;
    };

    while (i < tokens.length) {
        if (typeof tokens[i] === "string") {
            cmd = tokens[i++] as string;
        } else if (cmd === "M") {
            cmd = "L"; // implicit lineto after first moveto pair
        } else if (cmd === "m") {
            cmd = "l";
        }
        if (!cmd) return subpaths;

        const rel = cmd === cmd.toLowerCase(),
            C = cmd.toUpperCase();

        switch (C) {
            case "M": {
                let x = num(), y = num();
                if (rel) { x += cx; y += cy; }
                cx = x; cy = y;
                cur = startSub(cx, cy);
                break;
            }
            case "L": {
                let x = num(), y = num();
                if (rel) { x += cx; y += cy; }
                cx = x; cy = y;
                if (!cur) cur = startSub(cx, cy); else cur.points.push({ x: cx, y: cy });
                break;
            }
            case "H": {
                let x = num();
                if (rel) x += cx;
                cx = x;
                if (!cur) cur = startSub(cx, cy); else cur.points.push({ x: cx, y: cy });
                break;
            }
            case "V": {
                let y = num();
                if (rel) y += cy;
                cy = y;
                if (!cur) cur = startSub(cx, cy); else cur.points.push({ x: cx, y: cy });
                break;
            }
            case "C": {
                let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
                if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
                if (!cur) cur = startSub(cx, cy);
                flattenCubic(cx, cy, x1, y1, x2, y2, x, y, tol, cur.points);
                prevCx = x2; prevCy = y2;
                cx = x; cy = y;
                break;
            }
            case "S": {
                let x2 = num(), y2 = num(), x = num(), y = num();
                if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
                const pc = prevCmd && "CS".includes(prevCmd.toUpperCase());
                const x1 = pc ? 2 * cx - prevCx : cx,
                    y1 = pc ? 2 * cy - prevCy : cy;
                if (!cur) cur = startSub(cx, cy);
                flattenCubic(cx, cy, x1, y1, x2, y2, x, y, tol, cur.points);
                prevCx = x2; prevCy = y2;
                cx = x; cy = y;
                break;
            }
            case "Q": {
                let x1 = num(), y1 = num(), x = num(), y = num();
                if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
                if (!cur) cur = startSub(cx, cy);
                flattenQuadratic(cx, cy, x1, y1, x, y, tol, cur.points);
                prevQx = x1; prevQy = y1;
                cx = x; cy = y;
                break;
            }
            case "T": {
                let x = num(), y = num();
                if (rel) { x += cx; y += cy; }
                const pq = prevCmd && "QT".includes(prevCmd.toUpperCase());
                const x1 = pq ? 2 * cx - prevQx : cx,
                    y1 = pq ? 2 * cy - prevQy : cy;
                if (!cur) cur = startSub(cx, cy);
                flattenQuadratic(cx, cy, x1, y1, x, y, tol, cur.points);
                prevQx = x1; prevQy = y1;
                cx = x; cy = y;
                break;
            }
            case "A": {
                let rx = num(), ry = num();
                const rot = num(), large = num(), sweep = num();
                let x = num(), y = num();
                if (rel) { x += cx; y += cy; }
                if (!cur) cur = startSub(cx, cy);
                flattenArc(cx, cy, rx, ry, rot, large, sweep, x, y, tol, cur.points);
                cx = x; cy = y;
                break;
            }
            case "Z": {
                if (cur) {
                    cur.closed = true;
                    cx = sx; cy = sy;
                }
                break;
            }
            default:
                return subpaths; // unknown command, bail out safely
        }
        prevCmd = cmd;
    }

    return subpaths;
};

// ---------------------------------------------------------------------------
// DXF document writer (AutoCAD R2000 / AC1015 ASCII)
// ---------------------------------------------------------------------------

const fmt = (n: number): string => {
    if (!isFinite(n)) return "0";
    if (Math.abs(n) < 1e-9) return "0";
    return n.toFixed(6).replace(/\.?0+$/, "");
};

// Build a full DXF document from entities. All geometry sits on the single layer
// "0"; the operation type is conveyed per-entity via colour (group code 62).
export const buildDxf = (entities: DxfEntity[]): string => {
    const out: (string | number)[] = [];
    let handle = 0x100;
    const nextHandle = (): string => (handle++).toString(16).toUpperCase();

    const g = (code: number, val: string | number): void => { out.push(code); out.push(val); };

    // HEADER
    g(0, "SECTION");
    g(2, "HEADER");
    g(9, "$ACADVER"); g(1, "AC1015");
    g(9, "$INSUNITS"); g(70, 4); // 4 = millimetres
    g(9, "$HANDSEED"); g(5, "FFFF");
    g(0, "ENDSEC");

    // TABLES (only the mandatory "0" layer; operations are distinguished by colour)
    g(0, "SECTION");
    g(2, "TABLES");
    g(0, "TABLE");
    g(2, "LAYER");
    g(5, nextHandle());
    g(100, "AcDbSymbolTable");
    g(70, 1);
    g(0, "LAYER");
    g(5, nextHandle());
    g(100, "AcDbSymbolTableRecord");
    g(100, "AcDbLayerTableRecord");
    g(2, "0");
    g(70, 0);
    g(62, 7);
    g(6, "CONTINUOUS");
    g(0, "ENDTAB");
    g(0, "ENDSEC");

    // ENTITIES
    g(0, "SECTION");
    g(2, "ENTITIES");
    entities.forEach(e => {
        const pts = e.points;
        if (!pts || pts.length < 2) return;
        if (pts.length === 2 && !e.closed) {
            g(0, "LINE");
            g(5, nextHandle());
            g(100, "AcDbEntity");
            g(8, "0");
            g(62, e.color);
            g(100, "AcDbLine");
            g(10, fmt(pts[0]!.x)); g(20, fmt(pts[0]!.y)); g(30, "0");
            g(11, fmt(pts[1]!.x)); g(21, fmt(pts[1]!.y)); g(31, "0");
        } else {
            g(0, "LWPOLYLINE");
            g(5, nextHandle());
            g(100, "AcDbEntity");
            g(8, "0");
            g(62, e.color);
            g(100, "AcDbPolyline");
            g(90, pts.length);
            g(70, e.closed ? 1 : 0);
            pts.forEach(p => { g(10, fmt(p.x)); g(20, fmt(p.y)); });
        }
    });
    g(0, "ENDSEC");

    g(0, "EOF");

    return out.join("\r\n") + "\r\n";
};
