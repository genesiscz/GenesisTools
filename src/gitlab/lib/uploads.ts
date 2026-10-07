import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSecureHost, type ProjectApi, projectBase, restWrite } from "@app/gitlab/lib/client";

const IMAGE_LINK = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
// A scheme has two or more letters: "C:" is a Windows drive, not a URL.
const REMOTE = /^(?:[a-z][a-z0-9+.-]+:|\/uploads\/|\/-\/)/i;
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface UploadedFile {
    localPath: string;
    url: string;
}

export type Uploader = (localPath: string) => Promise<string>;

function decoded(target: string): string {
    try {
        return decodeURIComponent(target);
    } catch {
        return target;
    }
}

/** A markdown image target as a local file path, or null when it points somewhere remote. */
export function localImagePath(target: string, baseDir: string): string | null {
    if (/^file:/i.test(target)) {
        return fileURLToPath(target);
    }

    if (REMOTE.test(target)) {
        return null;
    }

    const path = decoded(target);

    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return resolve(homedir(), path.slice(2));
    }

    return isAbsolute(path) || WINDOWS_ABSOLUTE.test(path) ? path : resolve(baseDir, path);
}

/**
 * Where fenced code blocks and inline code spans sit in `body`, as [start, end) offsets. An image
 * written there is a markdown example, not an image, so its file is never uploaded.
 */
export function codeRanges(body: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let open: { marker: string; start: number } | null = null;
    let offset = 0;

    for (const line of body.split("\n")) {
        const marker = FENCE.exec(line)?.[1];

        if (open === null && marker) {
            open = { marker, start: offset };
        } else if (
            open &&
            marker &&
            marker[0] === open.marker[0] &&
            marker.length >= open.marker.length &&
            line.trim() === marker
        ) {
            ranges.push([open.start, offset + line.length]);
            open = null;
        }

        offset += line.length + 1;
    }

    if (open) {
        ranges.push([open.start, body.length]);
    }

    // Blank the fences first, so a backtick inside one never pairs with one outside it.
    const masked = ranges.reduce(
        (text, [start, end]) => text.slice(0, start) + " ".repeat(end - start) + text.slice(end),
        body
    );

    for (const match of masked.matchAll(INLINE_CODE)) {
        ranges.push([match.index, match.index + match[0].length]);
    }

    return ranges;
}

/** Why a local file must not be uploaded, or null when it is an image of an acceptable size. */
export function uploadRefusal(localPath: string, maxBytes = MAX_IMAGE_BYTES): string | null {
    if (!IMAGE_EXTENSIONS.includes(extname(localPath).toLowerCase())) {
        return `${localPath} is not an image (${IMAGE_EXTENSIONS.join(" ")})`;
    }

    let size: number;

    try {
        const stat = statSync(localPath);

        if (!stat.isFile()) {
            return `${localPath} is not a file`;
        }

        size = stat.size;
    } catch {
        return `image file not found: ${localPath}`;
    }

    return size > maxBytes ? `${localPath} is ${size} bytes, over the ${maxBytes} byte limit` : null;
}

/**
 * Replaces every `![alt](<local file>)` in `body` with the URL the uploader returns. Each file is
 * uploaded once, however often it appears. Every file is checked before the first upload, so a
 * missing, oversized or non-image file uploads nothing. An image inside a code block or an inline
 * code span is left alone: it shows markdown, and its file is not the author's to publish.
 */
export async function rewriteLocalImages(
    body: string,
    baseDir: string,
    uploader: Uploader,
    maxBytes = MAX_IMAGE_BYTES
): Promise<{ body: string; uploaded: UploadedFile[] }> {
    const targets = new Map<string, string>();
    const code = codeRanges(body);
    const inCode = (index: number): boolean => code.some(([start, end]) => index >= start && index < end);

    for (const match of body.matchAll(IMAGE_LINK)) {
        if (inCode(match.index)) {
            continue;
        }

        const target = match[2] ?? "";
        const localPath = localImagePath(target, baseDir);

        if (localPath) {
            targets.set(target, localPath);
        }
    }

    const refusals = [...new Set(targets.values())]
        .map((path) => uploadRefusal(path, maxBytes))
        .filter((reason): reason is string => reason !== null);

    if (refusals.length > 0) {
        throw new Error(`Nothing was uploaded: ${refusals.join("; ")}`);
    }

    const urls = new Map<string, string>();
    const byPath = new Map<string, string>();
    const uploaded: UploadedFile[] = [];

    for (const [target, localPath] of targets) {
        let url = byPath.get(localPath);

        if (!url) {
            url = await uploader(localPath);
            byPath.set(localPath, url);
            uploaded.push({ localPath, url });
        }

        urls.set(target, url);
    }

    const rewritten = body.replace(IMAGE_LINK, (whole, alt: string, target: string, index: number) => {
        const url = inCode(index) ? undefined : urls.get(target);

        return url ? `![${alt}](${url})` : whole;
    });

    return { body: rewritten, uploaded };
}

/** Uploads one file to the project; the returned `/uploads/…` URL renders in any comment on it. */
export async function uploadToProject(api: ProjectApi, localPath: string): Promise<string> {
    assertSecureHost(api.host);
    const form = new FormData();
    form.append("file", Bun.file(localPath), basename(localPath));
    const created = await restWrite<{ url?: string }>(api, {
        method: "POST",
        path: `${projectBase(api)}/uploads`,
        body: form,
        timeout: 60_000,
    });

    if (!created?.url) {
        throw new Error(`upload of ${localPath} returned no url`);
    }

    return created.url;
}
