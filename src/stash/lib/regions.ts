import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { type ParsedMarker, parseMarkers } from "./markers";

export interface DiscoveredRegion extends ParsedMarker {
    filePath: string;
    absPath: string;
}

const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".bun",
    ".cache",
    "coverage",
    "target",
    "vendor",
    ".venv",
    "__pycache__",
]);

export async function discoverRegionsInTree(rootDir: string): Promise<DiscoveredRegion[]> {
    const out: DiscoveredRegion[] = [];
    await walk(rootDir, rootDir, out);
    return out;
}

async function walk(rootDir: string, dir: string, out: DiscoveredRegion[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(rootDir, abs, out);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        const st = await stat(abs);
        if (st.size > 1_000_000) {
            continue;
        }
        let content: string;
        try {
            content = await readFile(abs, "utf8");
        } catch {
            continue;
        }
        if (!content.includes("@stash:")) {
            continue;
        }
        const markers = parseMarkers(content);
        for (const m of markers) {
            out.push({
                ...m,
                filePath: relative(rootDir, abs),
                absPath: abs,
            });
        }
    }
}

export async function extractRegionContent(filePath: string, regionName: string): Promise<string | null> {
    const content = await readFile(filePath, "utf8");
    const markers = parseMarkers(content);
    const m = markers.find((x) => x.name === regionName);
    if (!m) {
        return null;
    }
    const lines = content.split("\n");
    return lines.slice(m.contentStartLine - 1, m.contentEndLine).join("\n");
}
