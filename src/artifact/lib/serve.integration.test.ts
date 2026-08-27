import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViteDevServer } from "vite";
import { serveArtifacts } from "./serve";
import { resolveTemplateDir } from "./templates";

/**
 * The middleware wrapper the unit tests cannot reach: shell injection, markdown
 * rendering, asset rewrites and the SPA-style route remainder all run through
 * Vite, so a mock req/res would only assert the stub. This boots the real
 * server on an ephemeral port and makes real requests.
 */

let dir: string;
let outside: string;
let server: ViteDevServer;
let base: string;

async function get(path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${base}${path}`);

    return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "artifact-serve-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "artifact-serve-outside-")));

    writeFileSync(join(dir, "widget.tsx"), "export default () => null;\n");
    writeFileSync(join(dir, "notes.md"), "# Notes\n\nplain body\n");
    writeFileSync(join(dir, "report.html"), "<html><head></head><body>REPORT_BODY</body></html>");
    writeFileSync(join(dir, "data.json"), `{"a":1}`);
    mkdirSync(join(dir, "deep"));
    writeFileSync(join(dir, "deep", "inner.md"), "# Inner\n");

    writeFileSync(join(dir, "evil.md"), '# Evil\n\n<img src=x onerror="alert(1)">\n\n[go](javascript:alert(2))\n');

    writeFileSync(join(outside, "secret.md"), "# TOP_SECRET_MARKER\n");
    symlinkSync(join(outside, "secret.md"), join(dir, "escape.md"));

    // Port 0 asks the OS for a free one; strictPort is false so this cannot
    // collide with a dev server the developer already has running.
    server = await serveArtifacts({ dir, port: 0, host: "127.0.0.1", templateDir: resolveTemplateDir(undefined) });
    base = server.resolvedUrls?.local[0]?.replace(/\/$/, "") ?? "";
}, 60_000);

afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

describe("serveArtifacts middleware", () => {
    test("the root serves the catalog with clean hrefs for every artifact kind", async () => {
        const { status, body } = await get("/");
        expect(status).toBe(200);
        expect(body).toContain(`href="/widget"`);
        expect(body).toContain(`href="/notes"`);
        expect(body).toContain(`href="/report"`);
        // /__catalog is the explicit route for the same page.
        expect((await get("/__catalog")).body).toContain(`href="/widget"`);
    });

    test("a clean tsx URL serves the mount shell with the artifact base injected", async () => {
        const { status, body } = await get("/widget");
        expect(status).toBe(200);
        expect(body).toContain("__ARTIFACT_BASE__");
        expect(body).toContain(`"/widget"`);
        expect(body).toContain("/__artifact-entry/widget.tsx");
    });

    test("a route remainder under a tsx artifact still serves the shell (deep-link reload)", async () => {
        const { status, body } = await get("/widget/item/42");
        expect(status).toBe(200);
        expect(body).toContain("/__artifact-entry/widget.tsx");
    });

    test("an asset request under the /__tsx/ URL space rewrites back to the real root path", async () => {
        const { status, body } = await get("/__tsx/widget.tsx/data.json");
        expect(status).toBe(200);
        expect(body).toContain(`"a"`);
    });

    test("markdown renders through the page chrome, on the clean URL and on /__md/", async () => {
        const clean = await get("/notes");
        expect(clean.status).toBe(200);
        expect(clean.body).toContain("<h1");
        expect(clean.body).toContain("plain body");
        expect((await get("/__md/deep/inner.md")).body).toContain("Inner");
    });

    test("raw HTML and javascript: links in a served markdown file cannot execute", async () => {
        const { body } = await get("/evil");
        // The escaped text still contains the words; what matters is that no
        // <img TAG and no href reaches the DOM.
        expect(body).not.toContain("<img src=x");
        expect(body).not.toContain('href="javascript:');
        expect(body).toContain("&lt;img src=x");
        expect(body).toContain("<p>go</p>");
    });

    test("an html artifact is served by Vite through the clean URL", async () => {
        const { status, body } = await get("/report");
        expect(status).toBe(200);
        expect(body).toContain("REPORT_BODY");
    });

    test("a symlink out of the served folder is refused on every route that can reach it", async () => {
        // The clean URL, the markdown route and the raw path must all miss: the
        // rewrite that hands an html path to Vite only ever runs after the same
        // containment check, so nothing downstream can see the target either.
        expect((await get("/escape")).status).toBe(404);
        expect((await get("/__md/escape.md")).status).toBe(404);

        for (const path of ["/escape", "/__md/escape.md", "/escape.md"]) {
            expect((await get(path)).body).not.toContain("TOP_SECRET_MARKER");
        }
    });

    test("a missing tsx artifact 404s instead of serving an empty shell", async () => {
        expect((await get("/__tsx/nope.tsx")).status).toBe(404);
    });

    test("a directory resolves to its own catalog with prefixed hrefs", async () => {
        const { status, body } = await get("/deep");
        expect(status).toBe(200);
        expect(body).toContain(`href="/deep/inner"`);
    });
});
