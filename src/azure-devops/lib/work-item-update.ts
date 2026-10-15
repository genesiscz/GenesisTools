import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { JsonPatchOperation, WorkItemLive } from "@app/azure-devops/types";
import { SafeJSON } from "@genesiscz/utils/json";

/** An image already stored on the work item. Keyed by the file's base name. */
export interface UploadedImage {
    sha256: string;
    url: string;
}

export interface WorkItemUpdateImage {
    src: string;
    name: string;
    sha256: string;
    bytes: Uint8Array;
}

export interface WorkItemUpdateClient {
    read(id: number): Promise<WorkItemLive>;
    upload(fileName: string, bytes: Uint8Array): Promise<string>;
    update(id: number, operations: JsonPatchOperation[]): Promise<void>;
}

export interface WorkItemUpdateInput {
    id: number;
    /** When set, the update is refused unless the work item is still at this rev. */
    rev?: number;
    fields: { name: string; value: string }[];
    /** Multiline fields the caller wants stored as Markdown. Names come from the caller. */
    markdownFields: string[];
    images: WorkItemUpdateImage[];
    reuse: ReadonlyMap<string, UploadedImage>;
    confirm: boolean;
}

export interface WorkItemUpdatePlan {
    rev: number;
    operations: JsonPatchOperation[];
    uploads: { src: string; name: string; sha256: string }[];
    reused: { src: string; url: string }[];
}

export type WorkItemUpdateResult =
    | { ok: true; dryRun: true; plan: WorkItemUpdatePlan }
    | { ok: true; dryRun: false; rev: number; images: Record<string, UploadedImage>; plan: WorkItemUpdatePlan }
    | { ok: false; error: string; mismatches?: { field: string; sent: string; stored: string }[] };

/** Local `<img src>` values. `http`, `https` and `data` sources are already remote. */
export function localImageSources(html: string): string[] {
    const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1] ?? "");

    return [...new Set(sources.filter((src) => src !== "" && !/^(https?:|data:)/.test(src)))];
}

export function replaceImageSources(html: string, urls: ReadonlyMap<string, string>): string {
    let out = html;

    for (const [src, url] of urls) {
        out = out.replaceAll(`src="${src}"`, `src="${url}"`);
    }

    return out;
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Sources whose file still matches a previous upload, mapped to that attachment URL. */
export function imageReuseMap(
    sources: readonly string[],
    files: ReadonlyMap<string, string>,
    uploaded: ReadonlyMap<string, UploadedImage>
): Map<string, string> {
    const urls = new Map<string, string>();

    for (const src of sources) {
        const known = uploaded.get(basename(src));
        const sha256 = files.get(src);

        if (known && sha256 && known.sha256 === sha256 && known.url !== "") {
            urls.set(src, known.url);
        }
    }

    return urls;
}

/**
 * One patch: refuse the write when the rev moved, switch the named multiline fields to Markdown,
 * then set the fields. A field that is already Markdown is left alone.
 */
export function workItemPatch(input: {
    rev: number;
    fields: { name: string; value: string }[];
    markdownFields: readonly string[];
    liveFormats: Readonly<Record<string, string | undefined>>;
}): JsonPatchOperation[] {
    const operations: JsonPatchOperation[] = [{ op: "test", path: "/rev", value: input.rev }];

    for (const field of input.markdownFields) {
        if ((input.liveFormats[field] ?? "").toLowerCase() === "markdown") {
            continue;
        }

        operations.push({ op: "add", path: `/multilineFieldsFormat/${field}`, value: "Markdown" });
    }

    for (const field of input.fields) {
        operations.push({ op: "add", path: `/fields/${field.name}`, value: field.value });
    }

    return operations;
}

/**
 * True when the stored markdown is the markdown that was sent, up to the rewrites the server applies:
 * an emoji becomes a numeric (or hex) character reference, a quoted integer attribute loses its quotes
 * (`width="375"` stored as `width=375`; `width="48%"` keeps the quotes), and a local image src is the
 * attachment URL from `images`. Comments, added semicolons and insignificant space are ignored too.
 */
export function sameStoredMarkdown(
    stored: string,
    sent: string,
    images: ReadonlyMap<string, string> = new Map()
): boolean {
    return (
        normalizeAdoMarkdown(replaceImageSources(stored, images)) ===
        normalizeAdoMarkdown(replaceImageSources(sent, images))
    );
}

function normalizeAdoMarkdown(value: string): string {
    return value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/(\s[\w:-]+)="(\d+)"/g, "$1=$2")
        .replace(/;/g, "")
        .replace(/\s*(<[^>]+>)\s*/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

export function parseFieldSpec(spec: string, readFile: (path: string) => string): { name: string; value: string } {
    const eq = spec.indexOf("=");

    if (eq <= 0) {
        throw new Error(`--field expects Name=value or Name=@file, got '${spec}'`);
    }

    const name = spec.slice(0, eq);
    const raw = spec.slice(eq + 1);

    if (!raw.startsWith("@")) {
        return { name, value: raw };
    }

    const path = raw.slice(1);

    if (path === "") {
        throw new Error(`--field ${name} has an empty @ path`);
    }

    return { name, value: readFile(path) };
}

export function parseReuseFile(text: string): Map<string, UploadedImage> {
    const parsed: unknown = SafeJSON.parse(text);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--reuse must be a JSON object of { name: { sha256, url } }");
    }

    const uploaded = new Map<string, UploadedImage>();

    for (const [name, value] of Object.entries(parsed)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`--reuse entry ${name} must be an object`);
        }

        const sha256 = "sha256" in value ? value.sha256 : undefined;
        const url = "url" in value ? value.url : undefined;

        if (typeof sha256 !== "string" || typeof url !== "string" || sha256 === "" || url === "") {
            throw new Error(`--reuse entry ${name} needs sha256 and url strings`);
        }

        uploaded.set(name, { sha256, url });
    }

    return uploaded;
}

function fieldText(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Read, substitute images, and either describe the patch or send it and compare the read-back. */
export async function executeWorkItemUpdate(
    client: WorkItemUpdateClient,
    input: WorkItemUpdateInput
): Promise<WorkItemUpdateResult> {
    const live = await client.read(input.id);

    if (input.rev !== undefined && input.rev !== live.rev) {
        return { ok: false, error: `work item ${input.id} is at rev ${live.rev}, not ${input.rev}` };
    }

    const bySrc = new Map(input.images.map((image) => [image.src, image]));
    const sources = [...new Set(input.fields.flatMap((field) => localImageSources(field.value)))];
    const files = new Map(input.images.map((image) => [image.src, image.sha256]));
    const reuse = imageReuseMap(sources, files, input.reuse);
    const uploads: WorkItemUpdateImage[] = [];

    for (const src of sources) {
        if (reuse.has(src)) {
            continue;
        }

        const image = bySrc.get(src);

        if (!image) {
            return { ok: false, error: `local image not provided: ${src}` };
        }

        uploads.push(image);
    }

    const urls = new Map(reuse);

    if (input.confirm) {
        for (const image of uploads) {
            urls.set(image.src, await client.upload(image.name, image.bytes));
        }
    }

    const fields = input.fields.map((field) => ({ name: field.name, value: replaceImageSources(field.value, urls) }));
    const operations = workItemPatch({
        rev: live.rev,
        fields,
        markdownFields: input.markdownFields,
        liveFormats: live.multilineFieldsFormat,
    });
    const plan: WorkItemUpdatePlan = {
        rev: live.rev,
        operations,
        uploads: uploads.map(({ src, name, sha256 }) => ({ src, name, sha256 })),
        reused: [...reuse.entries()].map(([src, url]) => ({ src, url })),
    };

    if (!input.confirm) {
        return { ok: true, dryRun: true, plan };
    }

    await client.update(input.id, operations);
    const after = await client.read(input.id);
    const mismatches: { field: string; sent: string; stored: string }[] = [];

    for (const field of fields) {
        const stored = fieldText(after.fields[field.name]);

        if (!sameStoredMarkdown(stored, field.value)) {
            mismatches.push({ field: field.name, sent: field.value, stored });
        }

        const wantsMarkdown = input.markdownFields.includes(field.name) && field.value !== "";

        if (wantsMarkdown && (after.multilineFieldsFormat[field.name] ?? "").toLowerCase() !== "markdown") {
            mismatches.push({
                field: field.name,
                sent: "Markdown",
                stored: after.multilineFieldsFormat[field.name] ?? "",
            });
        }
    }

    if (mismatches.length > 0) {
        return {
            ok: false,
            error: `work item ${input.id} was updated to rev ${after.rev}, but the read-back differs`,
            mismatches,
        };
    }

    const images: Record<string, UploadedImage> = {};

    for (const [name, uploaded] of input.reuse) {
        images[name] = uploaded;
    }

    for (const image of input.images) {
        const url = urls.get(image.src);

        if (url) {
            images[image.name] = { sha256: image.sha256, url };
        }
    }

    return { ok: true, dryRun: false, rev: after.rev, images, plan };
}
