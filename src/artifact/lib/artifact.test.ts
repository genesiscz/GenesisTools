import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    resolveEmbedBudget,
    resolveEntry,
    resolveOutPath,
} from "./build";
import {
    artifactPathSet,
    cachedScan,
    cleanHref,
    renderCatalogHtml,
    resolveCleanUrl,
    safeResolve,
    scanArtifacts,
} from "./catalog";
import { renderMarkdown } from "./markdown";
import { addEntry, loadRegistry, removeEntry, resolveTarget } from "./registry";
import { findRunning, holdServer, isSignalable, listRunning, recordRunning, removeRunning } from "./running";
import { runningPath } from "./storage";
import { listShippedTemplates, renderTemplate, resolveTemplateDir } from "./templates";
import { fsAllowRoots } from "./vite";

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

    /**
     * Regression test: listRunning() pruned dead pids by WRITING the file, and
     * did it outside the lock that recordRunning/removeRunning both take. So
     * `tools artifact ps` — a list command — mutated durable state, and could
     * clobber a concurrently-starting serve's record. CLAUDE.md: a path named
     * list/show/status may read and report, nothing else.
     */
    test("listRunning does not write the file", async () => {
        await recordRunning({ pid: process.pid, port: 3998, dir, name: "live", startedAt: new Date().toISOString() });
        await recordRunning({ pid: 999999998, port: 3997, dir, name: "dead", startedAt: new Date().toISOString() });

        const path = runningPath();
        const before = readFileSync(path, "utf8");
        const beforeMtime = statSync(path).mtimeMs;

        expect(listRunning().map((s) => s.name)).toEqual(["live"]);

        expect(readFileSync(path, "utf8")).toBe(before);
        expect(statSync(path).mtimeMs).toBe(beforeMtime);
        // The dead record is filtered from the RESULT but still on disk; the
        // write paths are what prune it.
        expect(before).toContain("dead");

        await removeRunning(process.pid);
    });

    /**
     * serve and `library up` each inlined this block. A start path that forgets
     * one line of it leaves a server invisible to `ps`/`stop`, or leaks Vite
     * watchers on the way out, so there is exactly one copy of it now.
     */
    test("holdServer records the server, installs both signal handlers, and never resolves", async () => {
        const sigint = process.listenerCount("SIGINT");
        const sigterm = process.listenerCount("SIGTERM");
        let settled = false;
        // holdServer blocks forever by contract; the record it writes first is
        // what this asserts on.
        void holdServer({ port: 3995, dir, name: "held", close: () => Promise.resolve() }).then(() => {
            settled = true;
        });
        await Bun.sleep(50);

        expect(listRunning().map((s) => s.name)).toContain("held");
        expect(process.listenerCount("SIGINT")).toBe(sigint + 1);
        expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
        expect(settled).toBe(false);

        // The handlers call process.exit; leaving them on the test process would
        // turn a stray signal into a silent exit(0).
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const added = process.listeners(signal).at(-1);

            if (added) {
                process.off(signal, added as () => void);
            }
        }

        await removeRunning(process.pid);
    });

    /**
     * `stop` used to call findRunning (which classifies every recorded pid) and
     * then isSignalable on the match, classifying the SAME pid a second time.
     * findRunning now hands its identity back so the decision is free.
     */
    test("findRunning returns the identity it already computed, probing each pid once", async () => {
        await recordRunning({ pid: process.pid, port: 3996, dir, name: "solo", startedAt: new Date().toISOString() });

        const probed: number[] = [];
        const realKill = process.kill.bind(process);
        process.kill = ((pid: number, signal?: string | number) => {
            if (signal === 0) {
                probed.push(pid);
            }

            return realKill(pid, signal);
        }) as typeof process.kill;

        try {
            const match = findRunning("solo");

            expect(match?.server.name).toBe("solo");
            expect(match?.identity.status).toBe("live");
            expect(isSignalable(match?.identity ?? { status: "dead", pid: 0 })).toBe(true);
            expect(probed).toEqual([process.pid]);
        } finally {
            process.kill = realKill;
        }

        await removeRunning(process.pid);
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

const MB_BUDGET = { limitBytes: 1024 * 1024, totalBytes: 1024 * 1024 };

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

    test("an image href is protocol-filtered the same way a link href is", () => {
        for (const scheme of ["javascript:alert(1)", "vbscript:msgbox", "data:text/html;base64,PHN2Zz4="]) {
            const html = renderMarkdown(`![x](${scheme})`);
            expect(html).not.toContain("<img");
            expect(html).not.toContain(scheme);
            expect(html).toContain("x");
        }

        const ok = renderMarkdown('![alt text](https://example.com/a.png "the title")');
        expect(ok).toContain('src="https://example.com/a.png"');
        expect(ok).toContain('alt="alt text"');
        expect(ok).toContain('title="the title"');
    });

    test("an external link carries rel=noreferrer noopener", () => {
        expect(renderMarkdown("[ok](https://example.com)")).toContain('rel="noreferrer noopener"');
    });
});

describe("cleanHref ownership", () => {
    const listing = { tsx: ["a/report.tsx", "solo.tsx"], html: ["a/report.html"], md: ["a/report.md", "notes.md"] };

    test("the highest-precedence artifact owns the clean URL, the rest keep a raw path", () => {
        const paths = artifactPathSet(listing);

        expect(cleanHref("a/report.tsx", paths)).toBe("/a/report");
        expect(cleanHref("a/report.html", paths)).toBe("/a/report.html");
        expect(cleanHref("a/report.md", paths)).toBe("/__md/a/report.md");
        expect(cleanHref("solo.tsx", paths)).toBe("/solo");
        expect(cleanHref("notes.md", paths)).toBe("/notes");
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

    // The page shell is shared by EVERY template, so a literal color in it is
    // baked into themes it was never picked for. `bone` is light (--bg #f3f4f2),
    // and the headings used to be a hardcoded #eef2f8: near-white on near-white.
    test("the shared page shell colors nothing literally, only through theme tokens", () => {
        const shell = readFileSync(join(resolveTemplateDir(undefined), "page.html"), "utf8");
        const styles = shell.slice(shell.indexOf("<style>"), shell.lastIndexOf("</style>"));

        expect(styles).not.toMatch(/color:\s*#[0-9a-fA-F]{3,8}/);
        expect(styles).toContain("color: var(--text)");
    });

    test("every shipped theme defines the tokens the shared page shell paints with", () => {
        const required = ["--bg", "--text", "--dim", "--border", "--panel", "--accent"];
        const missing = listShippedTemplates().flatMap((name) => {
            const theme = readFileSync(join(resolveTemplateDir(name), "theme.css"), "utf8");

            return required.filter((token) => !theme.includes(`${token}:`)).map((token) => `${name}${token}`);
        });

        expect(missing).toEqual([]);
        expect(listShippedTemplates().length).toBeGreaterThanOrEqual(6);
    });
});

describe("dev-server filesystem exposure", () => {
    // Vite serves every allowed path over /@fs/<absolute path>, and `serve --host`
    // publishes that beyond loopback, so this list IS the blast radius.
    test("only the served dir, the repo's src and its node_modules are reachable", () => {
        const roots = fsAllowRoots("/tmp/served");
        const repo = resolve(import.meta.dir, "../../..");

        expect(roots).toEqual(["/tmp/served", join(repo, "src"), join(repo, "node_modules")]);
        expect(roots).not.toContain(repo);
    });

    test("the repo's non-source trees stay off the list", () => {
        const roots = fsAllowRoots("/tmp/served");
        const repo = resolve(import.meta.dir, "../../..");

        for (const tree of [".claude", ".github", "plugins", "scripts"]) {
            expect(roots.some((root) => join(repo, tree).startsWith(`${root}/`))).toBe(false);
        }
    });

    test("both start paths share ONE definition, so neither can drift open", () => {
        const serveSource = readFileSync(join(import.meta.dir, "serve.ts"), "utf8");
        const librarySource = readFileSync(join(import.meta.dir, "library.ts"), "utf8");

        expect(serveSource).toContain("fs: { allow: fsAllowRoots(");
        expect(librarySource).toContain("fs: { allow: fsAllowRoots(");
        expect(serveSource).not.toContain("REPO_ROOT");
        expect(librarySource).not.toContain("REPO_ROOT");
    });
});

describe("embed budget", () => {
    test("defaults apply when the caller passes nothing", () => {
        expect(resolveEmbedBudget({})).toEqual({ limitBytes: 5 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
    });

    test("explicit megabytes convert to bytes", () => {
        expect(resolveEmbedBudget({ embedLimitMb: 0.5, embedTotalMb: 2 })).toEqual({
            limitBytes: 512 * 1024,
            totalBytes: 2 * 1024 * 1024,
        });
    });

    // Both defeat every comparison in admits(), so an unvalidated value does not
    // widen the cap, it REMOVES it — silently, while the build still reports ok.
    test("a cap that is not a finite positive number is refused, not silently uncapped", () => {
        expect(() => resolveEmbedBudget({ embedTotalMb: Number.NaN })).toThrow(/--max-embed-total/);
        expect(() => resolveEmbedBudget({ embedTotalMb: Number.POSITIVE_INFINITY })).toThrow(/--max-embed-total/);
        expect(() => resolveEmbedBudget({ embedTotalMb: 0 })).toThrow(/--max-embed-total/);
        expect(() => resolveEmbedBudget({ embedTotalMb: -1 })).toThrow(/--max-embed-total/);
        expect(() => resolveEmbedBudget({ embedLimitMb: Number.NaN })).toThrow(/--max-embed/);
        expect(() => resolveEmbedBudget({ embedLimitMb: Number.POSITIVE_INFINITY })).toThrow(/--max-embed/);
    });

    test("the CLI's own parse of a malformed flag is what the guard catches", () => {
        expect(() => resolveEmbedBudget({ embedTotalMb: Number.parseFloat("nope") })).toThrow(/finite/);
        expect(() => resolveEmbedBudget({ embedTotalMb: Number.parseFloat("Infinity") })).toThrow(/finite/);
        expect(resolveEmbedBudget({ embedTotalMb: Number.parseFloat("32") }).totalBytes).toBe(32 * 1024 * 1024);
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
        const scan = collectEmbeddableFiles(dir, MB_BUDGET, new Set());
        expect(scan.embedded).toEqual(["data.json", "notes.md"]);

        const tiny = collectEmbeddableFiles(dir, { limitBytes: 3, totalBytes: 1024 * 1024 }, new Set());
        expect(tiny.embedded).toEqual([]);
        expect(tiny.skipped.map((s) => s.rel).sort()).toEqual(["data.json", "notes.md"]);
        expect(tiny.skipped.map((s) => s.reason)).toEqual(["too-large", "too-large"]);
    });

    /**
     * The per-file cap bounds nothing on its own: a tree of files each just
     * under it embeds their SUM, which then travels through the shim JSON and
     * the output string.
     */
    test("a tree scan stops at the TOTAL embed budget, not just the per-file cap", () => {
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-budget-")));
        for (const name of ["a.md", "b.md", "c.md"]) {
            writeFileSync(join(own, name), "x".repeat(1000));
        }

        const scan = collectEmbeddableFiles(own, { limitBytes: 1024 * 1024, totalBytes: 2500 }, new Set());

        expect(scan.embedded).toHaveLength(2);
        expect(scan.totalBytes).toBe(2000);
        expect(scan.skipped).toHaveLength(1);
        expect(scan.skipped[0].reason).toBe("budget");

        rmSync(own, { recursive: true, force: true });
    });

    test("the referenced scan honours the same total budget", () => {
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-budget-ref-")));
        writeFileSync(join(own, "one.json"), `{"pad":"${"x".repeat(1000)}"}`);
        writeFileSync(join(own, "two.json"), `{"pad":"${"x".repeat(1000)}"}`);
        writeFileSync(join(own, "single.tsx"), `const a = "./one.json"; const b = "./two.json";`);

        const scan = collectReferencedFiles(
            own,
            "single.tsx",
            { limitBytes: 1024 * 1024, totalBytes: 1100 },
            new Set()
        );

        expect(scan.embedded).toHaveLength(1);
        expect(scan.skipped.map((s) => s.reason)).toEqual(["budget"]);

        rmSync(own, { recursive: true, force: true });
    });

    test("referenced embed scope inlines only what the entry names (vault safety)", () => {
        // Own tmp dir: mutating the shared fixture dir would couple this test
        // to execution order of the enumerating tests above.
        const own = realpathSync(mkdtempSync(join(tmpdir(), "artifact-ref-")));
        writeFileSync(join(own, "data.json"), `{"a":1}`);
        writeFileSync(join(own, "notes.md"), "# unreferenced");
        writeFileSync(join(own, "single.tsx"), `export default () => { fetch("./data.json"); return null; };\n`);
        writeFileSync(join(own, "single.data.extra.json"), `{"b":2}`);

        const scan = collectReferencedFiles(own, "single.tsx", MB_BUDGET, new Set());
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
            const scan = collectReferencedFiles(own, "single.tsx", MB_BUDGET, new Set());
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
            const scan = collectEmbeddableFiles(own, MB_BUDGET, new Set());
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
            expect(collectEmbeddableFiles(own, MB_BUDGET, new Set()).embedded).toEqual(["mine.md"]);
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
