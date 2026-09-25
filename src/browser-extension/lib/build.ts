import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { EXTENSION_SOURCE_DIR } from "./host/install";

export const DIST_DIR = resolve(import.meta.dirname, "..", "..", "..", "dist", "browser-extension");

const MODULE_ENTRIES = ["background.ts", "popup.ts", "options.ts", "route.ts"];
const STATIC_FILES = ["manifest.json", "popup.html", "options.html", "route.html"];
const ICONS = ["icon16.png", "icon48.png", "icon128.png"];

const log = logger.child({ component: "browser-extension/build" });

/**
 * Chromium refuses a content script it reads as non-UTF-8, and bundlers emit raw non-ASCII from
 * sources and dependencies. Escaping every non-ASCII UTF-16 unit keeps the output pure ASCII and
 * valid in strings, regex literals and identifiers alike (the YouTube extension does the same).
 */
export function asciiOnly(code: string): string {
    return code.replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function bundle(entrypoints: string[], outDir: string, format: "esm" | "iife"): Promise<string[]> {
    const result = await Bun.build({
        entrypoints: entrypoints.map((entry) => join(EXTENSION_SOURCE_DIR, entry)),
        outdir: outDir,
        target: "browser",
        format,
        splitting: false,
        minify: false,
        naming: { entry: "[name].js" },
    });

    if (!result.success) {
        throw new Error(`extension bundle failed: ${result.logs.map((entry) => String(entry)).join("\n")}`);
    }

    const written: string[] = [];

    for (const output of result.outputs) {
        await Bun.write(output.path, asciiOnly(await output.text()));
        written.push(output.path);
    }

    return written;
}

/** Every file the manifest points at must exist in the build, or the browser refuses to load it. */
export async function checkBuild(outDir: string): Promise<string[]> {
    const manifest: unknown = SafeJSON.parse(await Bun.file(join(outDir, "manifest.json")).text(), { strict: true });
    const text = SafeJSON.stringify(manifest, { strict: true });
    const referenced = [...text.matchAll(/"([\w/-]+\.(?:js|html|png))"/g)].map((match) => match[1]);
    const present = new Set([
        ...(await readdir(outDir)),
        ...(await readdir(join(outDir, "icons"))).map((name) => `icons/${name}`),
    ]);
    return [...new Set(referenced)].filter((file) => !present.has(file));
}

export async function buildExtension({ outDir = DIST_DIR }: { outDir?: string } = {}): Promise<{
    outDir: string;
    files: string[];
}> {
    await mkdir(join(outDir, "icons"), { recursive: true });
    const files = [...(await bundle(MODULE_ENTRIES, outDir, "esm")), ...(await bundle(["content.ts"], outDir, "iife"))];

    for (const name of STATIC_FILES) {
        await copyFile(join(EXTENSION_SOURCE_DIR, name), join(outDir, name));
        files.push(join(outDir, name));
    }

    for (const name of ICONS) {
        await copyFile(join(EXTENSION_SOURCE_DIR, "icons", name), join(outDir, "icons", name));
        files.push(join(outDir, "icons", name));
    }

    const missing = await checkBuild(outDir);

    if (missing.length > 0) {
        throw new Error(`the manifest points at files the build did not write: ${missing.join(", ")}`);
    }

    log.info({ outDir, files: files.length }, "extension built");
    return { outDir, files };
}
