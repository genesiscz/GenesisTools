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

/** An `<img>` tag's `src` in any valid HTML spelling: any case, spaces around `=`, double, single or no quotes. */
const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

/** Local `<img src>` values. `http`, `https` and `data` sources are already remote. */
export function localImageSources(html: string): string[] {
    const sources = [...html.matchAll(IMG_SRC)].map((match) => match[2] ?? match[3] ?? match[4] ?? "");

    return [...new Set(sources.filter((src) => src !== "" && !/^(https?:|data:)/i.test(src)))];
}

export function replaceImageSources(html: string, urls: ReadonlyMap<string, string>): string {
    return html.replace(IMG_SRC, (tag: string, prefix: string, dq?: string, sq?: string, bare?: string) => {
        const url = urls.get(dq ?? sq ?? bare ?? "");
        return url === undefined ? tag : `${prefix}"${url}"`;
    });
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

/** How a read-back is compared: Markdown keeps its lines, HTML ignores insignificant space, plain text is exact. */
export type StoredTextFormat = "markdown" | "html" | "plain";

const HTML_TAG = /<[a-zA-Z!/][^>]*>/;

/**
 * True when the stored text is the text that was sent, up to the rewrites the server applies to rich text:
 * an emoji becomes a numeric (or hex) character reference, a quoted integer attribute loses its quotes
 * (`width="375"` stored as `width=375`; `width="48%"` keeps the quotes), a declaration inside a tag gains a
 * closing semicolon, and a local image src is the attachment URL from `images`. Comments are ignored too.
 * Markdown keeps its line breaks and indentation, which carry meaning; HTML ignores insignificant space.
 * A plain field (a title, a tag list) must match exactly.
 */
export function sameStoredText(input: {
    stored: string;
    sent: string;
    format: StoredTextFormat;
    images?: ReadonlyMap<string, string>;
}): boolean {
    if (input.format === "plain") {
        return input.stored === input.sent;
    }

    const images = input.images ?? new Map<string, string>();
    return (
        normalizeAdoText(replaceImageSources(input.stored, images), input.format) ===
        normalizeAdoText(replaceImageSources(input.sent, images), input.format)
    );
}

function normalizeAdoText(value: string, format: "markdown" | "html"): string {
    const text = value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/&#(\d+);/g, (match, code: string) => codePointOr(Number(code), match))
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => codePointOr(Number.parseInt(hex, 16), match))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/(\s[\w:-]+)="(\d+)"/g, "$1=$2")
        .replace(/<[^>]+>/g, (tag) => tag.replace(/;(?=\s*["'>])/g, ""));

    if (format === "html") {
        // Space around a block tag is layout the server re-indents; space beside an inline tag is text.
        return text.replace(BLOCK_TAG_SPACE, "$1").replace(/\s+/g, " ").trim();
    }

    // Two or more trailing spaces are a Markdown hard break, so they survive as one canonical pair.
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, (space) => (space.length >= 2 ? "  " : ""))
        .trim();
}

const BLOCK_TAG_SPACE =
    /\s*(<\/?(?:p|div|br|hr|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|h[1-6]|blockquote|pre|section|article)\b[^>]*>)\s*/gi;

/** A numeric character reference outside Unicode (or a lone surrogate) stays as written instead of throwing. */
function codePointOr(code: number, original: string): string {
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
}

/** Markdown when the field is (or is being switched to) Markdown, HTML when the field or either value is HTML. */
function storedTextFormat(input: {
    name: string;
    sent: string;
    stored: unknown;
    markdownFields: readonly string[];
    formats: Readonly<Record<string, string | undefined>>;
}): StoredTextFormat {
    const format = (input.formats[input.name] ?? "").toLowerCase();

    if (format === "markdown" || input.markdownFields.includes(input.name)) {
        return "markdown";
    }

    const stored = typeof input.stored === "string" ? input.stored : "";
    return format === "html" || HTML_TAG.test(input.sent) || HTML_TAG.test(stored) ? "html" : "plain";
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

/** A stored field value as text: a number or boolean as written, an identity as `Name <unique name>`. */
function fieldText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    const identity = identityNames(value);
    return identity.length > 0 ? identity.join(" ") : "";
}

/** The names an identity field answers to: its display name, unique name, and `Name <unique name>`. */
function identityNames(value: unknown): string[] {
    if (value === null || typeof value !== "object") {
        return [];
    }

    const display = "displayName" in value && typeof value.displayName === "string" ? value.displayName : null;
    const unique = "uniqueName" in value && typeof value.uniqueName === "string" ? value.uniqueName : null;
    return [display, unique, display && unique ? `${display} <${unique}>` : null].filter(
        (name): name is string => name !== null
    );
}

/** Whether the read-back holds what was sent, compared by the stored value's own type and a text field's format. */
function storedMatches(stored: unknown, sent: string, format: StoredTextFormat): boolean {
    if (typeof stored === "number") {
        return sent.trim() !== "" && Number(sent) === stored;
    }

    if (typeof stored === "boolean") {
        return sent.trim().toLowerCase() === String(stored);
    }

    const identity = identityNames(stored);
    if (identity.length > 0) {
        return identity.some((name) => name.toLowerCase() === sent.trim().toLowerCase());
    }

    return sameStoredText({ stored: fieldText(stored), sent, format });
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
        const raw = after.fields[field.name];
        const format = storedTextFormat({
            name: field.name,
            sent: field.value,
            stored: raw,
            markdownFields: input.markdownFields,
            formats: after.multilineFieldsFormat,
        });

        if (!storedMatches(raw, field.value, format)) {
            mismatches.push({ field: field.name, sent: field.value, stored: fieldText(raw) });
        }
    }

    // On its own loop: `--markdown <field>` may switch a field it does not also set.
    for (const name of new Set(input.markdownFields)) {
        const sent = fields.find((field) => field.name === name);
        const value = sent ? sent.value : fieldText(after.fields[name]);

        if (value !== "" && (after.multilineFieldsFormat[name] ?? "").toLowerCase() !== "markdown") {
            mismatches.push({ field: name, sent: "Markdown", stored: after.multilineFieldsFormat[name] ?? "" });
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
