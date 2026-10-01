import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { shareRoutes } from "@app/dev-dashboard/server/routes/share";
import type { RouteContext, RouteResult } from "@app/dev-dashboard/server/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const PIC = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 fake-webp-bytes");
const SHOT = Buffer.from("\u0089PNG fake-png-found-by-name");
const SPACED = Buffer.from("\u0089PNG fake-png-in-a-spaced-folder");
const SECRET = Buffer.from("\u0089PNG an-unreferenced-vault-file");
const OUTSIDE = Buffer.from("\u0089PNG a-file-outside-the-vault");
const LOGO = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><!-- key sk-test-${"0".repeat(40)} --><script>alert(1)</script></svg>`
);
const DATA = '{"status":"ok","steps":[1,2]}';
const WRAP = [
    "---",
    "tags: [demo]",
    "---",
    "# Wrap",
    "",
    "First paragraph.",
    "",
    "Target paragraph on line eight.",
    "",
    "[s](secret.md) and [[secret]] and ![[secret.png]] and [x](file:///etc/hosts)",
].join("\n");
const SECRET_MD = "# not referenced by the shared note";
const OTHER_NOTE = "# an unpublished note";
const PUB = "# a published note";
const OUTSIDE_MD = "# outside the vault";
const FAKE_TOKEN = `sk-test-${"0".repeat(40)}`;
const CREDS = `{"service":"demo","apiKey":"${FAKE_TOKEN}"}`;
const CREDS_MD = `# Setup\n\nexport DEMO_KEY=${FAKE_TOKEN}\n`;
const GENERATOR = [
    "/**",
    " * Report.md is generated from Report.json by this file.",
    " * See [the note](wrap.md) and ![[pic.webp]].",
    " */",
    'const rows: string[] = ["a"];',
].join("\n");
const TOOL = Array.from({ length: 1000 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");

const NOTE = [
    "# Run",
    "![[../assets/pic.webp]]",
    "![[shot.png|300]]",
    "![spaced](../assets/dir%20x/b.png)",
    "![[logo.svg]]",
    "[[../assets/data.json]]",
    "![[escape.png]]",
    "`![[secret.png]]`",
    "[wrap:8](file://VAULT/Notes/wrap.md#L8)",
    "[[Other Note]]",
    "[[Pub]]",
    "[tool.ts:5](file://VAULT/Notes/tool.ts#L5-L6)",
    "[tool.ts:500](../tool.ts#L500)",
    "[outside md](file://VAULT/../outside/x.md)",
    "[escape](../../../outside/x.md)",
    "[[../creds.json]]",
    "[creds md](../creds.md)",
    `inline key ${FAKE_TOKEN}`,
].join("\n\n");

function sha(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

describe("GET /share/:slug assets", () => {
    let dir = "";
    let slug = "";
    let pubSlug = "";
    let codeSlug = "";

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "share-assets-"));
        const vault = join(dir, "vault");
        mkdirSync(join(vault, "Notes/sub"), { recursive: true });
        mkdirSync(join(vault, "Notes/assets/dir x"), { recursive: true });
        mkdirSync(join(vault, "Other"), { recursive: true });
        mkdirSync(join(dir, "outside"), { recursive: true });
        writeFileSync(join(vault, "Notes/sub/Run.md"), NOTE.replaceAll("VAULT", vault));
        writeFileSync(join(vault, "Notes/wrap.md"), WRAP);
        writeFileSync(join(vault, "Notes/creds.json"), CREDS);
        writeFileSync(join(vault, "Notes/creds.md"), CREDS_MD);
        writeFileSync(join(vault, "Notes/tool.ts"), TOOL);
        writeFileSync(join(vault, "Notes/Report.ts"), GENERATOR);
        writeFileSync(join(vault, "Other/Other Note.md"), OTHER_NOTE);
        writeFileSync(join(vault, "Other/Pub.md"), PUB);
        writeFileSync(join(vault, "secret.md"), SECRET_MD);
        writeFileSync(join(dir, "outside/x.md"), OUTSIDE_MD);
        writeFileSync(join(vault, "Notes/assets/pic.webp"), PIC);
        writeFileSync(join(vault, "Notes/assets/dir x/b.png"), SPACED);
        writeFileSync(join(vault, "Notes/assets/data.json"), DATA);
        writeFileSync(join(vault, "Notes/sub/logo.svg"), LOGO);
        writeFileSync(join(vault, "Other/shot.png"), SHOT);
        writeFileSync(join(vault, "secret.png"), SECRET);
        writeFileSync(join(dir, "outside/escape.png"), OUTSIDE);
        symlinkSync(join(dir, "outside/escape.png"), join(vault, "Notes/sub/escape.png"));

        env.testing.set("GENESIS_TOOLS_HOME", join(dir, "home"));
        resetDevDashboardStorage();
        await getDevDashboardStorage().setConfig({
            port: 3042,
            obsidianVault: vault,
            publishedNotes: [],
            cmuxPollIntervalMs: 2000,
        });
        slug = (await publishNote("Notes/sub/Run.md")).slug;
        pubSlug = (await publishNote("Other/Pub.md")).slug;
        codeSlug = (await publishNote("Notes/Report.ts")).slug;
    });

    afterAll(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    async function get(query: Record<string, string>, accept = "*/*", target = slug): Promise<RouteResult> {
        const ctx: RouteContext = {
            method: "GET",
            pathname: `/share/${target}`,
            query: new URLSearchParams(query),
            params: { slug: target },
            headers: { accept },
            readJson: async () => {
                throw new Error("no body");
            },
            readRawBody: async () => new Uint8Array(),
            services: {} as RouteContext["services"],
        };

        return shareRoutes()[0].handler(ctx);
    }

    function assetUrl(bytes: Buffer | string): string {
        return `/share/${slug}?asset=${sha(bytes)}`;
    }

    test("the page carries content-hash URLs for every referenced image and the json chip", async () => {
        const page = await get({}, "text/html");

        expect(page.kind).toBe("raw");
        const html = page.kind === "raw" ? page.body : "";
        expect(html).toContain(`<img src="${assetUrl(PIC)}"`);
        expect(html).toContain(`<img src="${assetUrl(SHOT)}" alt="shot.png"`);
        expect(html).toContain(`<img src="${assetUrl(SPACED)}" alt="spaced"`);
        expect(html).toContain(`<img src="${assetUrl(LOGO)}"`);
        expect(html).toContain(`data-asset-panel="${assetUrl(DATA)}"`);
        expect(html).toContain(`href="${assetUrl(WRAP)}#L8" class="dd-md-asset-chip dd-md-asset-markdown"`);
        expect(html).toContain(`href="${assetUrl(TOOL)}#L5-L6" class="dd-md-asset-chip dd-md-asset-code"`);
        expect(html).toContain(`href="${assetUrl(TOOL)}#L500"`);
        expect(html).toContain(`data-asset-panel="${assetUrl(OTHER_NOTE)}"`);
        expect(html).toContain(`<a href="/share/${pubSlug}" class="dd-wikilink">Pub</a>`);
        expect(html).not.toContain(sha(OUTSIDE_MD));
        expect(html).not.toContain(sha(OUTSIDE));
        expect(html).not.toContain(sha(SECRET));
        expect(html).toContain('class="dd-md-embed-stub" data-target="escape.png"');
    });

    test("a referenced image is served with its type, nosniff and an immutable cache", async () => {
        const res = await get({ asset: sha(PIC) }, "image/*");

        expect(res.kind).toBe("binary");

        if (res.kind === "binary") {
            expect(res.status).toBe(200);
            expect(res.contentType).toBe("image/webp");
            expect(Buffer.from(res.body).equals(PIC)).toBe(true);
            expect(res.headers?.["X-Content-Type-Options"]).toBe("nosniff");
            expect(res.headers?.["Cache-Control"]).toContain("immutable");
        }
    });

    test("an svg is sandboxed so opening it directly cannot run its script", async () => {
        const res = await get({ asset: sha(LOGO) });

        expect(res.kind === "binary" && res.contentType).toBe("image/svg+xml");
        expect(res.kind === "binary" && res.headers?.["Content-Security-Policy"]).toContain("sandbox");
    });

    test("an svg is text, so a secret in it is masked like any text asset", async () => {
        const res = await get({ asset: sha(LOGO) });
        const body = res.kind === "binary" ? Buffer.from(res.body).toString("utf8") : "";

        expect(body).toContain("[redacted]");
        expect(body).not.toContain("sk-test-");
    });

    test.each([
        ["a traversal path", "../../etc/passwd"],
        ["a file name", "secret.png"],
        ["the hash of a vault file the note names only inside inline code", sha(SECRET)],
        ["a referenced hash in upper case", sha(PIC).toUpperCase()],
        ["the hash of the file a symlink escapes to", sha(OUTSIDE)],
        ["an unknown hash", "0".repeat(64)],
        ["a note path", "../../secret.md"],
        ["the hash of a note the shared note names only inside a referenced note", sha(SECRET_MD)],
        ["the hash of a note outside the vault behind a file: link", sha(OUTSIDE_MD)],
    ])("%s is a 404", async (_label, asset) => {
        const res = await get({ asset });

        expect(res.kind).toBe("raw");
        expect(res.kind === "raw" && res.status).toBe(404);
    });

    test("json: raw for a fetch, the page with the panel open for a browser, a highlighted fence for the panel", async () => {
        const raw = await get({ asset: sha(DATA) }, "application/json");
        expect(raw.kind === "binary" && Buffer.from(raw.body).toString("utf8")).toBe(DATA);
        expect(raw.kind === "binary" && raw.contentType).toContain("application/json");

        const page = await get({ asset: sha(DATA) }, "text/html,application/xhtml+xml,*/*;q=0.8");
        expect(page.kind === "raw" && page.body).toContain(
            `data-open-asset="${assetUrl(DATA).replace(/&/g, "&amp;")}"`
        );

        const fragment = await get({ asset: sha(DATA), view: "fragment" });
        const fragmentHtml = fragment.kind === "raw" ? fragment.body : "";
        expect(fragmentHtml).toContain('class="hljs language-json"');
        expect(fragmentHtml).toContain("hljs-attr");
        expect(fragmentHtml).toContain("&quot;status&quot;");
    });

    test("a referenced note renders in the panel with line anchors and inert nested references", async () => {
        const res = await get({ asset: sha(WRAP), view: "fragment" });
        const html = res.kind === "raw" ? res.body : "";

        expect(html).toContain('<div class="dd-src-block" data-line-start="8" data-line-end="8"><p>Target paragraph');
        expect(html).toContain('data-line-start="4" data-line-end="4"><h1');
        expect(html).toContain('<span class="dd-md-inert-link">s</span>');
        expect(html).toContain('<span class="dd-md-inert-link">x</span>');
        expect(html).toContain("dd-wikilink-unresolved");
        expect(html).not.toContain("?asset=");
        expect(html).not.toContain('href="secret.md"');
    });

    test("a code file renders a numbered window with the requested lines marked", async () => {
        const near = await get({ asset: sha(TOOL), view: "fragment", lines: "5-6" });
        const nearHtml = near.kind === "raw" ? near.body : "";

        expect(nearHtml).toContain('<span class="dd-code-line dd-line-hit" data-line="5">');
        expect(nearHtml).toContain('<span class="dd-code-line dd-line-hit" data-line="6">');
        expect(nearHtml).toContain('<span class="dd-code-line" data-line="4">');
        expect(nearHtml).toContain("Lines 1 to 400 of 1000");

        const far = await get({ asset: sha(TOOL), view: "fragment", lines: "500" });
        const farHtml = far.kind === "raw" ? far.body : "";

        expect(farHtml).toContain("Lines 460 to 859 of 1000");
        expect(farHtml).toContain('data-line="500"');
        expect(farHtml).not.toContain('data-line="459"');
        expect(farHtml).not.toContain('data-line="860"');
        expect(farHtml.match(/class="dd-code-line[ "]/g)?.length).toBe(400);
    });

    test("a shared source file is one highlighted block, and its comments link nothing", async () => {
        const page = await get({}, "text/html", codeSlug);
        const html = page.kind === "raw" ? page.body : "";

        expect(html).toContain('<code class="hljs language-typescript">');
        expect(html).toContain("<title>Report.ts");
        expect(html).toContain('a.download = "Report.ts";');
        expect(html).not.toContain("<li>");
        expect(html).not.toContain(sha(WRAP));
        expect(html).not.toContain(sha(PIC));
    });

    test("a code file is served raw as plain text", async () => {
        const res = await get({ asset: sha(TOOL), view: "raw" }, "text/html");

        expect(res.kind === "binary" && res.contentType).toBe("text/plain; charset=utf-8");
        expect(res.kind === "binary" && Buffer.from(res.body).toString("utf8")).toBe(TOOL);
    });

    test("secrets are masked on the page and in every asset path, while the hash names the file on disk", async () => {
        const page = await get({}, "text/html");
        const html = page.kind === "raw" ? page.body : "";

        expect(html).not.toContain(FAKE_TOKEN);
        expect(html).toContain("inline key [redacted]");
        expect(html).toContain(`data-asset-panel="${assetUrl(CREDS)}"`);
        expect(html).toContain(`data-asset-panel="${assetUrl(CREDS_MD)}"`);

        const bodies: string[] = [];

        for (const [query, accept] of [
            [{ asset: sha(CREDS), view: "fragment" }, "text/html"],
            [{ asset: sha(CREDS), view: "raw" }, "text/html"],
            [{ asset: sha(CREDS) }, "application/json"],
            [{ asset: sha(CREDS_MD), view: "fragment" }, "text/html"],
            [{ asset: sha(CREDS_MD), view: "raw" }, "text/html"],
            [{ asset: sha(CREDS_MD) }, "*/*"],
        ] as const) {
            const res = await get({ ...query }, accept);

            expect(res.kind === "raw" || res.kind === "binary").toBe(true);
            const body =
                res.kind === "raw" ? res.body : res.kind === "binary" ? Buffer.from(res.body).toString("utf8") : "";
            bodies.push(body);
        }

        for (const body of bodies) {
            expect(body).not.toContain(FAKE_TOKEN);
            expect(body).toContain("[redacted]");
        }

        expect(SafeJSON.parse(bodies[2], { strict: true })).toEqual({ service: "demo", apiKey: "[redacted]" });
        expect(bodies[4]).toBe("# Setup\n\nexport DEMO_KEY=[redacted]\n");
    });
});
