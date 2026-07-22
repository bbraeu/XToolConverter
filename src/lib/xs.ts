import { unzipSync, strFromU8 } from "fflate";
import type { XcsProject, XcsCanvas, XcsDisplay } from "./convert";

// ---------------------------------------------------------------------------
// .xs project files (xTool Studio, "xcs-workspace-v2")
//
// A .xs file is a ZIP archive holding the same data model as a v1 .xcs, split
// into parts:
//   project.json                          canvas order, active device id
//   canvases/<id>.json                    canvas metadata (title, chunk layout)
//   canvases/<id>/displays-<n>.json       display objects, chunked
//   vectors/<bucket>/data-<n>.json        deduplicated geometry (e.g. dPath
//                                         strings) referenced via vectorRef
//   profiles.json                         profileId -> processingType
//   devices/device-<id>.json              processing[canvasId].modes[mode]
//                                         .bindings: profile -> displayIds
//
// This module reassembles those parts into the v1 XcsProject shape so the
// whole SVG/DXF/FDS pipeline works unchanged.
// ---------------------------------------------------------------------------

interface XsProjectJson {
    activeDeviceId?: string;
    modules?: { canvases?: string[]; devices?: string[] };
}

interface XsCanvasJson {
    id: string;
    title?: string;
    chunkLayout?: { chunkIndexes?: number[] };
}

interface XsVectorRef {
    vectorHash: string;
    bucketType: string;
    originalField: string;
}

interface XsBinding {
    baseProfileId?: string;
    displayIds?: string[];
}

interface XsDeviceJson {
    processing?: Record<string, {
        activeMode?: string;
        modes?: Record<string, { bindings?: XsBinding[] }>;
    }>;
}

interface XsProfilesJson {
    profiles?: Record<string, { processingType?: string }>;
}

/** True if the buffer starts with the ZIP magic ("PK") — i.e. a .xs project. */
export const isXsArchive = (buf: ArrayBuffer): boolean => {
    const b = new Uint8Array(buf);
    return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b;
};

const readJson = <T>(files: Record<string, Uint8Array>, path: string): T | undefined => {
    const data = files[path];
    return data ? JSON.parse(strFromU8(data)) as T : undefined;
};

// Load every vectors/<bucket>/data-<n>.json into bucket -> hash -> value.
const loadVectorBuckets = (files: Record<string, Uint8Array>): Map<string, Record<string, unknown>> => {
    const buckets = new Map<string, Record<string, unknown>>();
    for (const path of Object.keys(files)) {
        const m = path.match(/^vectors\/([^/]+)\/data-\d+\.json$/);
        if (!m) continue;
        const oData = readJson<{ entries?: Record<string, unknown> }>(files, path);
        if (!oData?.entries) continue;
        const bucket = buckets.get(m[1]!) ?? {};
        Object.assign(bucket, oData.entries);
        buckets.set(m[1]!, bucket);
    }
    return buckets;
};

// v2 deduplicates heavy fields (like a PATH's dPath) into the vectors store;
// the display carries { vectorRef: { vectorHash, bucketType, originalField } }
// instead. Inline the referenced value back onto the display (and its nested
// TEXT charJSONs) so the v1 builders see the field where they expect it.
const inlineVectorRefs = (oDisplay: XcsDisplay, buckets: Map<string, Record<string, unknown>>): void => {
    const ref = (oDisplay as unknown as { vectorRef?: XsVectorRef }).vectorRef;
    if (ref?.vectorHash && ref.originalField) {
        const value = buckets.get(ref.bucketType)?.[ref.vectorHash];
        if (value !== undefined) {
            (oDisplay as unknown as Record<string, unknown>)[ref.originalField] = value;
        }
    }
    oDisplay.charJSONs?.forEach(c => inlineVectorRefs(c, buckets));
};

const loadCanvas = (
    files: Record<string, Uint8Array>,
    sCanvasId: string,
    buckets: Map<string, Record<string, unknown>>
): XcsCanvas | undefined => {
    const oMeta = readJson<XsCanvasJson>(files, `canvases/${sCanvasId}.json`);
    if (!oMeta) return undefined;

    const aChunks = oMeta.chunkLayout?.chunkIndexes ?? [0],
        aDisplays: XcsDisplay[] = [];

    aChunks.forEach(iChunk => {
        const oChunk = readJson<{ displays?: XcsDisplay[] }>(files, `canvases/${sCanvasId}/displays-${iChunk}.json`);
        oChunk?.displays?.forEach(oDisplay => {
            inlineVectorRefs(oDisplay, buckets);
            aDisplays.push(oDisplay);
        });
    });

    // v1 stores displays in stacking order; v2 keeps an explicit zOrder.
    aDisplays.sort((a, b) =>
        ((a as unknown as { zOrder?: number }).zOrder ?? 0) - ((b as unknown as { zOrder?: number }).zOrder ?? 0));

    return { id: sCanvasId, title: oMeta.title || "Canvas", displays: aDisplays };
};

// Rebuild the v1 device map (canvasId -> displayId -> processingType) from the
// v2 bindings: each binding ties a profile (which owns the processingType) to
// a list of display ids.
const buildDeviceData = (
    files: Record<string, Uint8Array>,
    oProject: XsProjectJson
): XcsProject["device"] => {
    const sDeviceId = oProject.activeDeviceId || oProject.modules?.devices?.[0];
    if (!sDeviceId) return undefined;

    const oDevice = readJson<XsDeviceJson>(files, `devices/device-${sDeviceId}.json`),
        oProfiles = readJson<XsProfilesJson>(files, "profiles.json")?.profiles ?? {};
    if (!oDevice?.processing) return undefined;

    const aValue = Object.entries(oDevice.processing).map(([sCanvasId, oProc]) => {
        const sMode = oProc.activeMode,
            aBindings = (sMode && oProc.modes?.[sMode]?.bindings) || [],
            aDisplays: [string, { processingType?: string }][] = [];

        aBindings.forEach(oBinding => {
            const sType = oBinding.baseProfileId ? oProfiles[oBinding.baseProfileId]?.processingType : undefined;
            oBinding.displayIds?.forEach(sId => aDisplays.push([sId, { processingType: sType }]));
        });

        return [sCanvasId, { mode: sMode, displays: { value: aDisplays } }] as
            [string, { mode?: string; displays?: { value?: [string, { processingType?: string }][] } }];
    });

    return { data: { value: aValue } };
};

/** Parse a .xs (xTool Studio) archive into the v1 XcsProject shape. */
export const parseXs = (buf: ArrayBuffer): XcsProject => {
    const files = unzipSync(new Uint8Array(buf)),
        oProject = readJson<XsProjectJson>(files, "project.json");

    if (!oProject?.modules?.canvases?.length) {
        throw new Error("not an xs project");
    }

    const buckets = loadVectorBuckets(files),
        aCanvas = oProject.modules.canvases
            .map(sId => loadCanvas(files, sId, buckets))
            .filter((c): c is XcsCanvas => !!c);

    if (!aCanvas.length) {
        throw new Error("no canvases found");
    }

    return { canvas: aCanvas, device: buildDeviceData(files, oProject) };
};
