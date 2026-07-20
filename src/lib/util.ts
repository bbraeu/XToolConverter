import { downloadZip } from "client-zip";

export interface ZipFileEntry {
    blob: Blob;
    file: string;
}

export async function downloadAsZip(aFiles: ZipFileEntry[], name: string): Promise<void> {
    const blob = await downloadZip(
        aFiles.map(o => ({
            name: o.file,
            lastModified: new Date(),
            input: o.blob
        }))
    ).blob();

    downloadBlob(blob, name);
}

export function downloadBlob(blob: Blob, name: string): void {
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = name;

    document.body.appendChild(link);
    // Dispatching a real MouseEvent is necessary as link.click() does not work
    // on the latest Firefox.
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    document.body.removeChild(link);

    URL.revokeObjectURL(blobUrl);
}

/** Google Analytics event helper — no-op when gtag is not loaded (dev). */
export function trackEvent(name: string): void {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    gtag?.("event", name);
}
