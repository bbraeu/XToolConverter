import { useCallback, useEffect, useRef, useState } from "react";
import { toSVG, toDXF, getUsedOperations } from "../lib/convert";
import type { XcsProject } from "../lib/convert";
import type { Operation } from "../lib/dxf";
import { downloadBlob, downloadAsZip, trackEvent } from "../lib/util";

interface CanvasResult {
    title: string;
    svg: string;
    dxf: string;
    fileName: string;
    operations: Operation[];
}

interface ConversionState {
    sourceName: string;
    canvases: CanvasResult[];
    excluded: string[];
}

interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

const dxfName = (sSource: string, sCanvas: string): string =>
    `${sSource.replace(/\.xcs$/i, "")}_${sCanvas.replaceAll(" ", "_")}.dxf`;

export default function Converter() {
    const [state, setState] = useState<ConversionState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [tab, setTab] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const convertFile = useCallback(async (file: File) => {
        setBusy(true);
        setError(null);
        setState(null);
        try {
            // Yield a frame so the busy state paints before the heavy work.
            await new Promise(r => setTimeout(r, 30));

            const oJSON = JSON.parse(await file.text()) as XcsProject;
            if (!Array.isArray(oJSON.canvas)) {
                throw new Error("not an xcs project");
            }

            const oSvg = toSVG(oJSON),
                oDxf = toDXF(oJSON);

            setState({
                sourceName: file.name,
                excluded: [...new Set(oSvg.aExcluded)],
                canvases: oSvg.aCanvas.map((oCanvas, i) => ({
                    title: oCanvas.title,
                    svg: oCanvas.svg,
                    dxf: oDxf.aCanvas[i]!.dxf,
                    fileName: dxfName(file.name, oCanvas.title),
                    operations: getUsedOperations(oJSON, oJSON.canvas[i]!)
                }))
            });
            setTab(0);
            trackEvent("Convert file");
        } catch {
            setError("This does not look like a valid .xcs file. Please select a project file saved by xTool Creative Space.");
        } finally {
            setBusy(false);
        }
    }, []);

    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void convertFile(file);
    }, [convertFile]);

    const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) void convertFile(file);
        e.target.value = ""; // allow re-selecting the same file
    }, [convertFile]);

    const downloadOne = (oCanvas: CanvasResult) => {
        downloadBlob(new Blob([oCanvas.dxf], { type: "application/dxf" }), oCanvas.fileName);
        trackEvent("Download regular");
    };

    const downloadAll = () => {
        if (!state) return;
        void downloadAsZip(
            state.canvases.map(c => ({ blob: new Blob([c.dxf], { type: "application/dxf" }), file: c.fileName })),
            state.sourceName.replace(/\.xcs$/i, "") + ".zip"
        );
        trackEvent("Download zip");
    };

    const active = state?.canvases[tab];
    const previewRef = useRef<HTMLDivElement>(null);
    const vbRef = useRef<ViewBox | null>(null);   // current viewBox
    const fitRef = useRef<ViewBox | null>(null);  // fit-to-content viewBox

    const getSvg = (): SVGSVGElement | null => previewRef.current?.querySelector("svg") ?? null;

    const applyVB = (svg: SVGSVGElement, vb: ViewBox): void => {
        svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    };

    // Zoom by `factor` around the given client point (container centre if omitted).
    const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
        const el = previewRef.current, svg = getSvg(), vb = vbRef.current, fit = fitRef.current;
        if (!el || !svg || !vb || !fit) return;
        const rect = el.getBoundingClientRect(),
            px = cx === undefined ? 0.5 : (cx - rect.left) / rect.width,
            py = cy === undefined ? 0.5 : (cy - rect.top) / rect.height,
            // clamp: max 60x in, 4x out relative to the fitted view
            w = Math.min(Math.max(vb.w / factor, fit.w / 60), fit.w * 4),
            f = vb.w / w,
            h = vb.h / f;
        vbRef.current = { x: vb.x + (vb.w - w) * px, y: vb.y + (vb.h - h) * py, w, h };
        applyVB(svg, vbRef.current);
    }, []);

    const resetView = useCallback(() => {
        const svg = getSvg();
        if (!svg || !fitRef.current) return;
        vbRef.current = { ...fitRef.current };
        applyVB(svg, vbRef.current);
    }, []);

    // Fit the preview to the design bounds (the .xcs work area is a fixed 430 mm
    // canvas, which would render small designs tiny) and wire up pan & zoom.
    useEffect(() => {
        const el = previewRef.current, svg = getSvg();
        if (!el || !svg) return;

        try {
            const bb = svg.getBBox(), pad = 5;
            let x = bb.x - pad, y = bb.y - pad,
                w = bb.width + pad * 2, h = bb.height + pad * 2;
            // Expand the box to the container's aspect ratio so pointer positions
            // map 1:1 onto viewBox coordinates (no letterboxing offsets).
            const aspect = el.clientWidth / el.clientHeight;
            if (w / h < aspect) { const nw = h * aspect; x -= (nw - w) / 2; w = nw; }
            else { const nh = w / aspect; y -= (nh - h) / 2; h = nh; }
            fitRef.current = { x, y, w, h };
            vbRef.current = { x, y, w, h };
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            applyVB(svg, vbRef.current);
        } catch {
            return; /* empty canvas — nothing to navigate */
        }

        // Wheel zoom towards the cursor (non-passive to keep the page from scrolling).
        const onWheel = (e: WheelEvent): void => {
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
        };
        el.addEventListener("wheel", onWheel, { passive: false });

        // Pointer drag pans the view.
        let dragging = false, lastX = 0, lastY = 0;
        const onDown = (e: PointerEvent): void => {
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            el.setPointerCapture(e.pointerId);
            el.style.cursor = "grabbing";
        };
        const onMove = (e: PointerEvent): void => {
            const vb = vbRef.current, s = getSvg();
            if (!dragging || !vb || !s) return;
            const rect = el.getBoundingClientRect();
            vbRef.current = {
                ...vb,
                x: vb.x - (e.clientX - lastX) * (vb.w / rect.width),
                y: vb.y - (e.clientY - lastY) * (vb.h / rect.height)
            };
            lastX = e.clientX;
            lastY = e.clientY;
            applyVB(s, vbRef.current);
        };
        const onUp = (e: PointerEvent): void => {
            dragging = false;
            el.style.cursor = "";
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        };
        const onDblClick = (): void => resetView();
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
        el.addEventListener("dblclick", onDblClick);

        return () => {
            el.removeEventListener("wheel", onWheel);
            el.removeEventListener("pointerdown", onDown);
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            el.removeEventListener("dblclick", onDblClick);
        };
    }, [state, tab, zoomBy, resetView]);

    return (
        <div className="mx-auto w-full max-w-3xl">
            {/* Drop zone */}
            <div
                role="button"
                tabIndex={0}
                aria-label="Select or drop an .xcs file"
                onClick={() => inputRef.current?.click()}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`group relative cursor-pointer overflow-hidden rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-300 outline-none
                    ${dragOver
                        ? "border-cyan-300 bg-cyan-400/10 scale-[1.02] shadow-[0_0_60px_-12px_rgba(34,211,238,0.6)]"
                        : "border-white/15 bg-white/[0.03] hover:border-cyan-400/60 hover:bg-white/[0.05] focus-visible:border-cyan-400/60"}`}
            >
                <div className="laser-beam" aria-hidden="true" />
                <input ref={inputRef} type="file" accept=".xcs" className="hidden" onChange={onPick} />

                <div className="pointer-events-none relative z-10 flex flex-col items-center gap-3">
                    <div className="grid size-16 place-items-center rounded-2xl bg-linear-to-br from-cyan-400/20 to-violet-500/20 ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-110">
                        <svg className="size-8 text-cyan-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                        </svg>
                    </div>
                    <p className="text-lg font-semibold text-white">
                        {busy ? "Converting…" : "Drop your .xcs file here"}
                    </p>
                    <p className="text-sm text-slate-400">
                        {busy ? "flattening curves to 0.01 mm" : "or click to browse — conversion runs 100% in your browser"}
                    </p>
                </div>
            </div>

            {error && (
                <div role="alert" className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
                    {error}
                </div>
            )}

            {state && (
                <div className="glass mt-8 overflow-hidden rounded-2xl">
                    {/* Header: file name + zip download */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
                        <p className="truncate text-sm text-slate-300">
                            <span className="mr-2 inline-block size-2 rounded-full bg-emerald-400 align-middle" aria-hidden="true" />
                            {state.sourceName}
                        </p>
                        {state.canvases.length > 1 && (
                            <button
                                onClick={downloadAll}
                                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-400/50 hover:text-white"
                            >
                                Download all as .zip
                            </button>
                        )}
                    </div>

                    {/* Canvas tabs */}
                    {state.canvases.length > 1 && (
                        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-white/10 px-3 pt-3">
                            {state.canvases.map((c, i) => (
                                <button
                                    key={c.title}
                                    role="tab"
                                    aria-selected={i === tab}
                                    onClick={() => setTab(i)}
                                    className={`rounded-t-lg px-4 py-2 text-sm font-medium transition
                                        ${i === tab
                                            ? "bg-white/10 text-white shadow-[inset_0_-2px_0_0_var(--color-accent)]"
                                            : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                                >
                                    {c.title}
                                </button>
                            ))}
                        </div>
                    )}

                    {active && (
                        <div className="p-5">
                            {/* Legend + download */}
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                <ul className="flex flex-wrap gap-2" aria-label="Operation types in this canvas">
                                    {active.operations.map(op => (
                                        <li key={op.name} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                                            <span className="size-2.5 rounded-full" style={{ background: op.css }} aria-hidden="true" />
                                            {op.name}
                                        </li>
                                    ))}
                                </ul>
                                <button
                                    onClick={() => downloadOne(active)}
                                    className="rounded-lg bg-linear-to-r from-cyan-500 to-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 active:scale-95"
                                >
                                    Download {active.fileName}
                                </button>
                            </div>

                            {/* SVG preview with pan & zoom */}
                            <div className="relative">
                                <div
                                    ref={previewRef}
                                    className="preview-grid h-120 cursor-grab touch-none overflow-hidden rounded-xl ring-1 ring-white/10 select-none"
                                    dangerouslySetInnerHTML={{ __html: active.svg }}
                                />
                                <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-lg bg-slate-900/80 ring-1 ring-white/15 backdrop-blur">
                                    <button aria-label="Zoom in" onClick={() => zoomBy(1.4)}
                                        className="px-3 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">+</button>
                                    <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}
                                        className="border-y border-white/10 px-3 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">−</button>
                                    <button aria-label="Reset view" title="Fit to design" onClick={resetView}
                                        className="px-3 py-2 text-slate-200 transition hover:bg-white/10 hover:text-white">⛶</button>
                                </div>
                                <p className="pointer-events-none absolute bottom-2 left-3 rounded-md bg-slate-900/70 px-2.5 py-1 text-[11px] text-slate-300 backdrop-blur">
                                    scroll to zoom · drag to pan · double-click to reset
                                </p>
                            </div>

                            {state.excluded.length > 0 && (
                                <p className="mt-3 text-xs text-amber-300/80">
                                    Skipped unsupported shape types: {state.excluded.join(", ")}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
