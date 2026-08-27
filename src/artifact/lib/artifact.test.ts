import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import {
    buildSingleFile,
    collectEmbeddableFiles,
    collectReferencedFiles,
    embedScopeFor,
    fetchShimScript,
    hasLocalAssetRefs,
    injectShim,
    inlineAssets,
    resolveEntry,
    resolveOutPath,
} from "./build";
import { cachedScan, renderCatalogHtml, resolveCleanUrl, safeResolve, scanArtifacts } from "./catalog";
import { renderMarkdown } from "./markdown";
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
    test("records live pids and prunes dead ones", async () => {
        await recordRunning({ pid: process.pid, port: 3999, dir, name: "self", startedAt: new Date().toISOString() });
        await recordRunning({ pid: 999999999, port: 4000, dir, name: "ghost", startedAt: new Date().toISOString() });

        const alive = listRunning();
        expect(alive.map((s) => s.name)).toContain("self");
        expect(alive.map((s) => s.name)).not.toContain("ghost");

        await removeRunning(process.pid);
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

describe("safeResolve containment", () => {
    test("resolves a real file inside the served dir", () => {
        expect(safeResolve(dir, "report.html")).toBe(join(dir, "report.html"));
        expect(safeResolve(dir, "notes.md")).toBe(join(dir, "notes.md"));
    });

    test("rejects ../ traversal, directories and missing files", () => {
        expect(safeResolve(dir, "../etc/passwd")).toBeNull();
        expect(safeResolve(dir, "node_modules")).toBeNull();
        expect(safeResolve(dir, "nope.html")).toBeNull();
    });

    test("rejects a SYMLINK that points outside the served dir", () => {
        // resolve() does not follow symlinks, so the path STRING stays inside
        // `dir` while the real file is elsewhere. Only a realpath check catches it.
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-outside-")));
        const secret = join(outside, "secret.md");
        writeFileSync(secret, "top secret");
        const link = join(dir, "escape.md");
        symlinkSync(secret, link);

        try {
            expect(safeResolve(dir, "escape.md")).toBeNull();
            // The clean-URL router must not reach it either.
            expect(resolveCleanUrl(dir, "/escape")).toBeNull();
        } finally {
            rmSync(link, { force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("rejects a symlinked DIRECTORY escape instead of serving its catalog", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-outside-dir-")));
        writeFileSync(join(outside, "leak.md"), "# leak");
        const link = join(dir, "escapedir");
        symlinkSync(outside, link);

        try {
            expect(resolveCleanUrl(dir, "/escapedir")).toBeNull();
        } finally {
            rmSync(link, { force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a malformed percent-encoding is a miss, not a throw", () => {
        expect(safeResolve(dir, "%zz.html")).toBeNull();
        expect(resolveCleanUrl(dir, "/%zz")).toBeNull();
    });
});

describe("catalog enumeration containment", () => {
    test("a symlinked directory escape is not walked and its files are not listed", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-escape-")));
        writeFileSync(join(outside, "leak.md"), "# leak");
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-root-")));
        writeFileSync(join(own, "mine.md"), "# mine");
        symlinkSync(outside, join(own, "elsewhere"));

        try {
            const listing = scanArtifacts(own);
            expect(listing.md).toEqual(["mine.md"]);
            expect(listing.md.join(" ")).not.toContain("leak");
        } finally {
            rmSync(own, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a symlinked FILE escape is not listed, and a broken symlink does not throw", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-file-")));
        const secret = join(outside, "secret.md");
        writeFileSync(secret, "top secret");
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-file-root-")));
        writeFileSync(join(own, "mine.md"), "# mine");
        symlinkSync(secret, join(own, "escape.md"));
        symlinkSync(join(outside, "gone.md"), join(own, "dangling.md"));

        try {
            expect(scanArtifacts(own).md).toEqual(["mine.md"]);
        } finally {
            rmSync(own, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a self-referential symlink does not send the walk into a cycle", () => {
        // `loop -> .` passes the containment check (its target IS the root), so
        // the escape guard alone leaves an unbounded recursion.
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-cycle-")));
        writeFileSync(join(own, "mine.md"), "# mine");
        symlinkSync(own, join(own, "loop"));

        try {
            expect(scanArtifacts(own).md).toEqual(["mine.md"]);
        } finally {
            rmSync(own, { recursive: true, force: true });
        }
    });

    test("a symlink whose target stays INSIDE the folder is still listed", () => {
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-inside-")));
        mkdirSync(join(own, "real"));
        writeFileSync(join(own, "real", "page.md"), "# page");
        symlinkSync(join(own, "real"), join(own, "alias"));

        try {
            expect(scanArtifacts(own).md.sort()).toEqual(["alias/page.md", "real/page.md"]);
        } finally {
            rmSync(own, { recursive: true, force: true });
        }
    });
});

describe("markdown rendering is not a script injection", () => {
    test("raw HTML in a source file is escaped, never emitted as markup", () => {
        const html = renderMarkdown('# hi\n\n<img src=x onerror="alert(1)">\n');
        // The escaped text keeps the words; what matters is that no TAG survives.
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img src=x onerror=");
    });

    test("a javascript: link renders as plain text, http links survive", () => {
        const bad = renderMarkdown("[click](javascript:alert(1))");
        expect(bad).not.toContain("javascript:");
        expect(bad).not.toContain("<a ");
        expect(bad).toContain("click");
        expect(renderMarkdown("[ok](https://example.com)")).toContain('href="https://example.com"');
    });
});

describe("clean URL resolution", () => {
    test("longest matching prefix wins and the remainder stays a client route", () => {
        expect(resolveCleanUrl(dir, "/widget")).toMatchObject({ kind: "tsx", rel: "widget.tsx", base: "/widget" });
        expect(resolveCleanUrl(dir, "/widget/item/42")).toMatchObject({ kind: "tsx", rel: "widget.tsx" });
        expect(resolveCleanUrl(dir, "/report")).toMatchObject({ kind: "html", rel: "report.html" });
        expect(resolveCleanUrl(dir, "/notes")).toMatchObject({ kind: "md", rel: "notes.md" });
    });

    test("a route remainder is only allowed after a React artifact", () => {
        expect(resolveCleanUrl(dir, "/notes/anything")).toBeNull();
        expect(resolveCleanUrl(dir, "/report/anything")).toBeNull();
    });
});

describe("catalog scan cache", () => {
    test("repeat page loads reuse the scan, and a later one re-walks", () => {
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-scan-")));
        writeFileSync(join(own, "a.md"), "# a");

        const t0 = 1_000_000;
        expect(cachedScan(own, t0).md).toEqual(["a.md"]);

        // A file added within the TTL is intentionally NOT visible yet.
        writeFileSync(join(own, "b.md"), "# b");
        expect(cachedScan(own, t0 + 100).md).toEqual(["a.md"]);

        // Past the TTL the folder is walked again.
        expect(cachedScan(own, t0 + 10_000).md.sort()).toEqual(["a.md", "b.md"]);

        rmSync(own, { recursive: true, force: true });
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
    test("resolveEntry picks the single html, honors explicit html/tsx/md, rejects others", () => {
        expect(resolveEntry(dir, undefined)).toBe("report.html");
        expect(resolveEntry(dir, "report.html")).toBe("report.html");
        expect(resolveEntry(dir, "widget.tsx")).toBe("widget.tsx");
        expect(resolveEntry(dir, "notes.md")).toBe("notes.md");
        expect(() => resolveEntry(dir, "data.json")).toThrow(/\.html, \.tsx\/\.jsx or \.md/);
    });

    test("resolveOutPath turns every non-html entry into a sibling .html", () => {
        expect(resolveOutPath({ dir, entry: "notes.md" })).toBe(join(dir, "dist", "notes.html"));
        expect(resolveOutPath({ dir, entry: "widget.tsx" })).toBe(join(dir, "dist", "widget.html"));
        expect(resolveOutPath({ dir, entry: "report.html" })).toBe(join(dir, "dist", "report.html"));
    });

    test("a markdown entry builds into a self-contained themed page", async () => {
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-md-")));
        writeFileSync(join(own, "notes.md"), "# Heading\n\nbody paragraph\n");

        const result = await buildSingleFile({ dir: own, entry: "notes.md", embedScope: "referenced" });

        expect(result.outPath).toBe(join(own, "dist", "notes.html"));
        const html = readFileSync(result.outPath, "utf8");
        expect(html).toContain("<h1>Heading</h1>");
        expect(html).toContain("body paragraph");
        // Theme tokens are inlined, so the page needs no sibling stylesheet.
        expect(html).toContain("--accent:");
        expect(html).not.toContain('<link rel="stylesheet"');

        rmSync(own, { recursive: true, force: true });
    });

    test("hasLocalAssetRefs distinguishes local from external refs", () => {
        expect(hasLocalAssetRefs(`<script src="./main.ts"></script>`)).toBe(true);
        expect(hasLocalAssetRefs(`<link rel="stylesheet" href="style.css">`)).toBe(true);
        expect(hasLocalAssetRefs(`<script src="https://cdn.example/x.js"></script>`)).toBe(false);
        expect(hasLocalAssetRefs(`<script>inline()</script>`)).toBe(false);
    });

    test("hasLocalAssetRefs also catches a page whose only local ref is media", () => {
        // A standalone build that skipped bundling here emitted an HTML file
        // still pointing at a sibling image, which breaks once the file moves.
        expect(hasLocalAssetRefs(`<img src="./logo.png">`)).toBe(true);
        expect(hasLocalAssetRefs(`<video poster="shot.jpg"></video>`)).toBe(true);
        expect(hasLocalAssetRefs(`<audio src="clip.mp3"></audio>`)).toBe(true);
        expect(hasLocalAssetRefs(`<source src="movie.webm">`)).toBe(true);
        expect(hasLocalAssetRefs(`<img src="https://cdn.example/logo.png">`)).toBe(false);
        expect(hasLocalAssetRefs(`<img src="data:image/png;base64,AAA">`)).toBe(false);
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
        // Own tmp dir: mutating the shared fixture dir would couple this test
        // to execution order of the enumerating tests above.
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-ref-")));
        writeFileSync(join(own, "data.json"), `{"a":1}`);
        writeFileSync(join(own, "notes.md"), "# unreferenced");
        writeFileSync(join(own, "single.tsx"), `export default () => { fetch("./data.json"); return null; };\n`);
        writeFileSync(join(own, "single.data.extra.json"), `{"b":2}`);

        const scan = collectReferencedFiles(own, "single.tsx", 1024 * 1024, new Set());
        // notes.md exists in the dir but is NOT referenced — it must stay out.
        expect(scan.embedded).toEqual(["data.json", "single.data.extra.json"]);
        rmSync(own, { recursive: true, force: true });
    });

    test("a referenced file reached through a symlink is not inlined", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-embed-outside-")));
        writeFileSync(join(outside, "secret.json"), `{"secret":true}`);
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-embed-root-")));
        writeFileSync(join(own, "ok.json"), `{"a":1}`);
        symlinkSync(join(outside, "secret.json"), join(own, "data.json"));
        writeFileSync(
            join(own, "single.tsx"),
            `export default () => { fetch("./data.json"); fetch("./ok.json"); return null; };\n`
        );

        try {
            const scan = collectReferencedFiles(own, "single.tsx", 1024 * 1024, new Set());
            expect(scan.embedded).toEqual(["ok.json"]);
            expect(SafeJSON.stringify(scan.files)).not.toContain("secret");
        } finally {
            rmSync(own, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("the tree walk does not descend a symlinked directory that leaves the folder", () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-tree-outside-")));
        writeFileSync(join(outside, "vault.md"), "# private");
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-tree-root-")));
        writeFileSync(join(own, "mine.md"), "# mine");
        symlinkSync(outside, join(own, "elsewhere"));

        try {
            const scan = collectEmbeddableFiles(own, 1024 * 1024, new Set());
            expect(scan.embedded).toEqual(["mine.md"]);
            expect(SafeJSON.stringify(scan.files)).not.toContain("private");
        } finally {
            rmSync(own, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("a self-referential symlink does not send the embed walk into a cycle", () => {
        // collectEmbeddableFiles has no depth cap at all, so a `loop -> .` here
        // recurses until the path length or the stack gives out.
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-embed-cycle-")));
        writeFileSync(join(own, "mine.md"), "# mine");
        symlinkSync(own, join(own, "loop"));

        try {
            expect(collectEmbeddableFiles(own, 1024 * 1024, new Set()).embedded).toEqual(["mine.md"]);
        } finally {
            rmSync(own, { recursive: true, force: true });
        }
    });

    test("any explicitly named entry scopes embeds to referenced files (dir + --entry is not a vault dump)", () => {
        // Regression: `build <dir> --entry adr.tsx` embedded every sibling .md/.json
        // because scoping keyed only on target-was-a-file.
        expect(embedScopeFor({ fileTargetEntry: "single.tsx" })).toBe("referenced");
        expect(embedScopeFor({ entryFlag: "adr.tsx" })).toBe("referenced");
        expect(embedScopeFor({ registryEntry: "dash.tsx" })).toBe("referenced");
        expect(embedScopeFor({ fileTargetEntry: null })).toBe("tree");
        expect(embedScopeFor({})).toBe("tree");
    });

    test("fetch shim aliases entry-relative keys for subdirectory entries", () => {
        const shim = fetchShimScript({ "sub/data.json": `{"x":1}` }, "sub/report.html");
        // Both the dir-relative and the page-relative key must resolve.
        expect(shim).toContain(`"sub/data.json"`);
        expect(shim).toContain(`"data.json"`);
    });

    test("fetch shim escapes </script> and injectShim lands after <head>", () => {
        const shim = fetchShimScript({ "x.md": "</script><b>gotcha</b>" });
        expect(shim).not.toContain("</script><b>");
        expect(shim.split("</script>")).toHaveLength(2);

        const page = injectShim("<html><head><title>t</title></head></html>", "<script>s</script>");
        expect(page.indexOf("<script>s</script>")).toBeLessThan(page.indexOf("<title>"));
    });
});
