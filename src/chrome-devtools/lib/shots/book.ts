/**
 * A shot book: the table of annotated page shots of one project, as data. A `.ts` book is
 * `export default defineShots({...})` with the locator helpers imported from `@genesis-tools/shots` (served by this
 * loader, so the book's folder needs no node_modules); a `.json` or `.jsonc` book is the same object. Every locator
 * and part is parsed here, so a typo fails before a browser starts, with the shot and the field named.
 */
import { resolve } from "node:path";
import type { CdpLike } from "@genesiscz/utils/chrome-devtools/cdp-like";
import { type Locator, type LocatorSource, parseLocator } from "@genesiscz/utils/chrome-devtools/shots/locator";
import { DEFAULT_SETUP, type PageSetup } from "@genesiscz/utils/chrome-devtools/shots/page";
import {
    PART_DEFAULTS,
    type PartInput,
    parseShotPart,
    type ShotPart,
} from "@genesiscz/utils/chrome-devtools/shots/part";
import { isPresetName, type PresetName, readPlanValue } from "@genesiscz/utils/image";
import { type ImageFormat, SHOTS_MODULES, WEBP_OUTPUT, type WebpOutput } from "./quick.ts";

export type BrowserKind = "headless" | "attach";
export const BROWSER_KINDS: readonly BrowserKind[] = ["headless", "attach"];

/**
 * Where a headless browser's login cookies come from: your running browser (only the cookies the book's base URL
 * would send, kept in memory), a command that prints a JSON cookie array, or nowhere.
 */
export type CookieSource = { from: "browser"; port?: number } | { from: "command"; argv: string[] } | { from: "none" };

/** Nested by the browser axis: a key only one source reads lives under that source. */
export interface BrowserSettings {
    headless: { cookies: CookieSource; binary?: string };
    attach: { port?: number; tab: "new" | "current" };
}

export interface ShotInput extends PartInput {
    id: string;
    stem: string;
    note?: string;
    point?: number;
    /** More pages stacked under the first one in the same image. */
    parts?: PartInput[];
}

export interface BookInput {
    base?: string;
    viewport?: { width: number; height: number; scale?: number };
    browser?: {
        use?: BrowserKind;
        headless?: { cookies?: CookieSource; binary?: string };
        attach?: { port?: number; tab?: "new" | "current" };
    };
    look?: { preset?: PresetName; amberPreset?: PresetName };
    page?: { dismiss?: LocatorSource[]; settleMs?: number; freeze?: boolean; readyTimeoutMs?: number };
    output?: {
        /** The annotated image's formats: WebP in the output folder, PNG (full size) under `png/`. */
        formats?: ImageFormat[];
        /** Also write the raw image, full size, as `png/<stem>.<tag>.original.png`. */
        raw?: boolean;
        webp?: Partial<WebpOutput>;
    };
    shots: ShotInput[];
}

export interface Shot {
    id: string;
    stem: string;
    note?: string;
    point?: number;
    parts: ShotPart[];
}

export interface ShotBook {
    file: string;
    base?: string;
    use: BrowserKind;
    browser: BrowserSettings;
    setup: PageSetup;
    output: { formats: ImageFormat[]; raw: boolean; webp: WebpOutput };
    shots: Shot[];
}

export class ShotBookError extends Error {
    override name = "ShotBookError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
    throw new ShotBookError(`${path}: ${message}`);
}

function cookieSource(value: unknown, path: string): CookieSource {
    if (value === undefined) {
        return { from: "browser" };
    }

    if (!isRecord(value)) {
        fail(path, 'expected { from: "browser" | "command" | "none" }');
    }

    if (value.from === "none") {
        return { from: "none" };
    }

    if (value.from === "browser") {
        return typeof value.port === "number" ? { from: "browser", port: value.port } : { from: "browser" };
    }

    const argv = value.argv;
    if (
        value.from === "command" &&
        Array.isArray(argv) &&
        argv.length > 0 &&
        argv.every((arg) => typeof arg === "string")
    ) {
        return { from: "command", argv };
    }

    return fail(path, 'a command source needs argv: ["tool", "arg", ...]');
}

function positive(value: unknown, fallback: number, path: string, max = Number.POSITIVE_INFINITY): number {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
        fail(path, `expected a number from 0 to ${max}, got ${String(value)}`);
    }

    return value;
}

/** Parses a book value (already read) into a ShotBook; `file` names it in errors. */
export function parseShotBook(value: unknown, file: string, overrides: { base?: string } = {}): ShotBook {
    if (!isRecord(value) || !Array.isArray(value.shots) || value.shots.length === 0) {
        fail(file, "a book is an object with a non-empty shots array");
    }

    const input = value as unknown as BookInput;
    const look = input.look ?? {};
    for (const [key, preset] of Object.entries(look)) {
        if (preset !== undefined && !isPresetName(preset)) {
            fail(`${file}: look.${key}`, `unknown preset "${preset}"`);
        }
    }

    const defaults = {
        ...PART_DEFAULTS,
        ...(look.preset ? { preset: look.preset } : {}),
        ...(look.amberPreset ? { amberPreset: look.amberPreset } : {}),
    };
    const ids = new Set<string>();
    const stems = new Set<string>();
    const shots = input.shots.map((shot, index): Shot => {
        const path = `${file}: shots[${index}]`;
        if (!isRecord(shot) || typeof shot.id !== "string" || typeof shot.stem !== "string") {
            fail(path, "a shot needs an id and a stem");
        }

        if (!/^[\w.-]+$/.test(shot.stem)) {
            fail(path, `stem "${shot.stem}" may hold only letters, digits, dot, dash and underscore`);
        }

        if (ids.has(shot.id) || stems.has(shot.stem)) {
            fail(path, `id "${shot.id}" or stem "${shot.stem}" is used twice`);
        }

        ids.add(shot.id);
        stems.add(shot.stem);
        const parts = [shot, ...(shot.parts ?? [])].map((part, partIndex) =>
            parseShotPart(
                part,
                defaults,
                partIndex === 0 ? `${path} (${shot.id})` : `${path} (${shot.id}).parts[${partIndex - 1}]`
            )
        );

        return {
            id: shot.id,
            stem: shot.stem,
            parts,
            ...(shot.note !== undefined ? { note: shot.note } : {}),
            ...(shot.point !== undefined ? { point: shot.point } : {}),
        };
    });
    const use = input.browser?.use ?? "headless";
    if (!BROWSER_KINDS.includes(use)) {
        fail(`${file}: browser.use`, `expected ${BROWSER_KINDS.join(" or ")}`);
    }

    const page = input.page ?? {};
    const viewport = input.viewport ?? { width: 1440, height: 900 };
    const formats = input.output?.formats ?? ["webp"];
    if (formats.length === 0 || formats.some((format) => format !== "png" && format !== "webp")) {
        fail(`${file}: output.formats`, 'expected a list of "webp" and "png"');
    }

    const dismiss: Locator[] = (page.dismiss ?? []).map((source) => parseLocator(source));
    const base = overrides.base ?? input.base;

    return {
        file,
        ...(base ? { base } : {}),
        use,
        browser: {
            headless: {
                cookies: cookieSource(input.browser?.headless?.cookies, `${file}: browser.headless.cookies`),
                ...(input.browser?.headless?.binary ? { binary: input.browser.headless.binary } : {}),
            },
            attach: {
                ...(input.browser?.attach?.port !== undefined ? { port: input.browser.attach.port } : {}),
                tab: input.browser?.attach?.tab ?? "new",
            },
        },
        setup: {
            ...DEFAULT_SETUP,
            ...(base ? { base } : {}),
            viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale ?? 1 },
            dismiss,
            settleMs: positive(page.settleMs, DEFAULT_SETUP.settleMs, `${file}: page.settleMs`),
            freeze: page.freeze ?? true,
            readyTimeoutMs: positive(page.readyTimeoutMs, DEFAULT_SETUP.readyTimeoutMs, `${file}: page.readyTimeoutMs`),
            preset: defaults.preset,
        },
        output: {
            formats,
            raw: input.output?.raw === true,
            webp: {
                maxWidth: positive(input.output?.webp?.maxWidth, WEBP_OUTPUT.maxWidth, `${file}: output.webp.maxWidth`),
                quality: positive(
                    input.output?.webp?.quality,
                    WEBP_OUTPUT.quality,
                    `${file}: output.webp.quality`,
                    100
                ),
            },
        },
        shots,
    };
}

/** Reads and parses a `.ts`, `.json` or `.jsonc` book. */
export async function loadShotBook(path: string, overrides: { base?: string } = {}): Promise<ShotBook> {
    const file = resolve(path);
    return parseShotBook(await readPlanValue(file, { modules: SHOTS_MODULES }), file, overrides);
}

/** The shots `--only` names, by id or stem, in book order; an unknown name fails with the known ones. */
export function selectShots(book: ShotBook, only?: readonly string[]): Shot[] {
    if (!only || only.length === 0) {
        return book.shots;
    }

    const unknown = only.filter((name) => !book.shots.some((shot) => shot.id === name || shot.stem === name));
    if (unknown.length > 0) {
        throw new ShotBookError(
            `no shot named ${unknown.join(", ")} in ${book.file} (ids: ${book.shots.map((shot) => shot.id).join(", ")})`
        );
    }

    return book.shots.filter((shot) => only.includes(shot.id) || only.includes(shot.stem));
}

/** What a shot runs on, for the runner and for tests: a CDP session and how to let it go. */
export interface ShotTab {
    cdp: CdpLike;
    /** True when the tab shows a page the user also uses (attach to the current tab): no viewport override. */
    shared: boolean;
    close(): Promise<void>;
}
