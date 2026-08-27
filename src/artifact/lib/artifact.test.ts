import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import {
    collectEmbeddableFiles,
    collectReferencedFiles,
    fetchShimScript,
    hasLocalAssetRefs,
    injectShim,
    inlineAssets,
    resolveEntry,
} from "./build";
import { renderCatalogHtml, scanArtifacts } from "./catalog";
import { addEntry, loadRegistry, removeEntry, resolveTarget } from "./registry";
import { listRunning, recordRunning, removeRunning } from "./running";
import { renderTemplate, resolveTemplateDir } from "./templates";

setupStorageSandbox();

let dir: string;

beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "artifact-test-")));
    writeFileSync(join(dir, "report.html"), "<html><head></head><body>hi</body></html>");
    writeFileSync(join(dir, "notes.md"), "# hello");
    writeFileSync(join(dir, "widget.tsx"), "export default () => null;");
    writeFileSync(join(dir, "data.json"), `{"a":1}`);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "skipped.md"), "nope");
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("registry", () => {
    test("add, dedupe, resolve, remove", () => {
        const first = addEntry({ dir });
        expect(first.created).toBe(true);

        const again = addEntry({ dir });
        expect(again.created).toBe(false);
        expect(loadRegistry()).toHaveLength(1);

        const byName = resolveTarget(first.entry.name);
        expect(byName.dir).toBe(dir);
        expect(byName.registryEntry?.name).toBe(first.entry.name);

        const byPath = resolveTarget(dir);
        expect(byPath.registryEntry?.name).toBe(first.entry.name);

        expect(removeEntry(first.entry.name)?.dir).toBe(dir);
        expect(loadRegistry()).toHaveLength(0);
    });

    test("unknown target throws", () => {
        expect(() => resolveTarget("/definitely/not/a/dir")).toThrow();
    });

    test("a single FILE target resolves to parent dir + entry (no folder needed)", () => {
        const resolved = resolveTarget(join(dir, "report.html"));
        expect(resolved.dir).toBe(dir);
        expect(resolved.entry).toBe("report.html");

        const tsx = resolveTarget(join(dir, "widget.tsx"));
        expect(tsx.entry).toBe("widget.tsx");
    });
});

describe("running tracker", () => {
    test("records live pids and prunes dead ones", () => {
        recordRunning({ pid: process.pid, port: 3999, dir, name: "self", startedAt: new Date().toISOString() });
        recordRunning({ pid: 999999999, port: 4000, dir, name: "ghost", startedAt: new Date().toISOString() });

        const alive = listRunning();
        expect(alive.map((s) => s.name)).toContain("self");
        expect(alive.map((s) => s.name)).not.toContain("ghost");

        removeRunning(process.pid);
        expect(listRunning()).toHaveLength(0);
    });
});

describe("catalog", () => {
    test("scanArtifacts groups by kind and skips node_modules", () => {
        const listing = scanArtifacts(dir);
        expect(listing.html).toEqual(["report.html"]);
        expect(listing.md).toEqual(["notes.md"]);
        expect(listing.tsx).toEqual(["widget.tsx"]);
    });

    test("catalog html links every artifact through its clean route", () => {
        const html = renderCatalogHtml(dir, scanArtifacts(dir), resolveTemplateDir(undefined));
        expect(html).toContain(`href="/report"`);
        expect(html).toContain(`href="/widget"`);
        expect(html).toContain(`href="/notes"`);
    });
});

describe("templates", () => {
    test("renderTemplate fills placeholders and leaves unknown ones", () => {
        expect(renderTemplate("a {{X}} b {{Y}}", { X: "1" })).toBe("a 1 b {{Y}}");
    });

    test("unknown template name throws with the shipped list", () => {
        expect(() => resolveTemplateDir("nope-template")).toThrow(/default/);
    });
});

describe("build helpers", () => {
    test("resolveEntry picks the single html, honors explicit html/tsx, rejects others", () => {
        expect(resolveEntry(dir, undefined)).toBe("report.html");
        expect(resolveEntry(dir, "report.html")).toBe("report.html");
        expect(resolveEntry(dir, "widget.tsx")).toBe("widget.tsx");
        expect(() => resolveEntry(dir, "notes.md")).toThrow(/html or .tsx/);
    });

    test("hasLocalAssetRefs distinguishes local from external refs", () => {
        expect(hasLocalAssetRefs(`<script src="./main.ts"></script>`)).toBe(true);
        expect(hasLocalAssetRefs(`<link rel="stylesheet" href="style.css">`)).toBe(true);
        expect(hasLocalAssetRefs(`<script src="https://cdn.example/x.js"></script>`)).toBe(false);
        expect(hasLocalAssetRefs(`<script>inline()</script>`)).toBe(false);
    });

    test("inlineAssets inlines scripts and styles, drops modulepreload", () => {
        const html = [
            `<link rel="modulepreload" href="./chunk.js">`,
            `<link rel="stylesheet" href="./app.css">`,
            `<script type="module" src="./app.js"></script>`,
        ].join("\n");
        const assets: Record<string, string> = { "app.css": "body{}", "app.js": "run()" };
        const inlined = inlineAssets(html, (rel) => assets[rel]);
        expect(inlined).toContain("<style>\nbody{}\n</style>");
        expect(inlined).toContain(`<script type="module">\nrun()\n</script>`);
        expect(inlined).not.toContain("modulepreload");
    });

    test("collectEmbeddableFiles embeds text data, skips node_modules and oversize", () => {
        const scan = collectEmbeddableFiles(dir, 1024 * 1024, new Set());
        expect(scan.embedded).toEqual(["data.json", "notes.md"]);

        const tiny = collectEmbeddableFiles(dir, 3, new Set());
        expect(tiny.embedded).toEqual([]);
        expect(tiny.skipped.map((s) => s.rel).sort()).toEqual(["data.json", "notes.md"]);
    });

    test("referenced embed scope inlines only what the entry names (vault safety)", () => {
        writeFileSync(join(dir, "single.tsx"), `export default () => { fetch("./data.json"); return null; };\n`);
        writeFileSync(join(dir, "single.data.extra.json"), `{"b":2}`);

        const scan = collectReferencedFiles(dir, "single.tsx", 1024 * 1024, new Set());
        // notes.md exists in the dir but is NOT referenced — it must stay out.
        expect(scan.embedded).toEqual(["data.json", "single.data.extra.json"]);
    });

    test("fetch shim escapes </script> and injectShim lands after <head>", () => {
        const shim = fetchShimScript({ "x.md": "</script><b>gotcha</b>" });
        expect(shim).not.toContain("</script><b>");
        expect(shim.split("</script>")).toHaveLength(2);

        const page = injectShim("<html><head><title>t</title></head></html>", "<script>s</script>");
        expect(page.indexOf("<script>s</script>")).toBeLessThan(page.indexOf("<title>"));
    });
});
