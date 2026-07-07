import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";

const EXT_BY_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "text/html": "html",
    "text/markdown": "md",
    "application/json": "json",
};

export const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    html: "text/html",
    md: "text/markdown",
    json: "application/json",
    txt: "text/plain",
    css: "text/css",
    js: "text/javascript",
};

export function blobsDir(): string {
    return join(getDevDashboardStorage().getBaseDir(), "boards", "blobs");
}

export function mimeForPath(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Content-addressed write. Returns the blob key `<sha256hex>.<ext>`. Idempotent. */
export async function putBlob(data: Uint8Array, mime: string): Promise<string> {
    const hash = createHash("sha256").update(data).digest("hex");
    const ext = EXT_BY_MIME[mime] ?? "bin";
    const key = `${hash}.${ext}`;
    const dir = join(blobsDir(), hash.slice(0, 2));
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const path = join(dir, key);
    if (!existsSync(path)) {
        await Bun.write(path, data);
    }
    return key;
}

const BLOB_KEY_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

/** Resolve a blob key to its fs path; null for malformed keys or missing blobs. */
export function blobPath(key: string): string | null {
    if (!BLOB_KEY_RE.test(key)) {
        return null;
    }
    const path = join(blobsDir(), key.slice(0, 2), key);
    return existsSync(path) ? path : null;
}

export function blobUrl(key: string): string {
    return `/api/boards/blobs/${key}`;
}
