import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { convertHtml, isEngineName, listEngines, unknownEngineMessage } from "./lib/convert";
import { extractContent } from "./lib/extract";
import { keepsHeaders } from "./lib/fetch";
import { compactCodeBlocks, compactWhitespace, normalizeMarkdown, validateMarkdown } from "./lib/markdown";
import { readPage } from "./lib/read";
import { buildJinaUrl, ensureHttpUrl } from "./lib/urls";
import { createWebReaderServer } from "./mcp/server";

const PROSE =
    "Readable prose sits in this paragraph, long enough to count as content, with commas, clauses, and detail.";

function page(body: string, head = "<title>Fixture page</title>"): string {
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("urls", () => {
    test("a bare host gets https, an http URL is kept, whitespace is trimmed", () => {
        expect(ensureHttpUrl("example.com/a")).toBe("https://example.com/a");
        expect(ensureHttpUrl("  http://example.com ")).toBe("http://example.com/");
    });

    test("something that is not a URL throws a message that quotes it", () => {
        expect(() => ensureHttpUrl("not a url")).toThrow('Not a valid URL: "not a url"');
    });

    test("the Jina address wraps the normalised page URL", () => {
        expect(buildJinaUrl("example.com")).toBe("https://r.jina.ai/https://example.com/");
    });
});

describe("engines", () => {
    test("turndown is the only engine, and the removed ones say so", () => {
        expect(listEngines().map((engine) => engine.name)).toEqual(["turndown"]);
        expect(isEngineName("turndown")).toBe(true);
        expect(isEngineName("mdream")).toBe(false);
        expect(unknownEngineMessage("mdream")).toBe(
            'Engine "mdream" was removed (it needed the mdream package). Available engines: turndown.'
        );
        expect(unknownEngineMessage("readerlm")).toContain("was removed");
        expect(unknownEngineMessage("toString")).toBe('Unknown engine "toString". Available engines: turndown.');
    });
});

describe("extractContent", () => {
    test("main wins over navigation, banner, sidebar and footer", () => {
        const html = page(`
            <header><a href="/">Site</a><nav><a href="/a">Home</a><a href="/b">Docs</a></nav></header>
            <div class="layout sidebar-wrap">
                <aside><nav><a href="/x">Sidebar link</a></nav></aside>
                <main><h1>Title</h1><p>${PROSE}</p><p>${PROSE}</p></main>
            </div>
            <footer>Copyright footer text that is long enough to matter in a naive scorer.</footer>`);
        const result = extractContent(html, "https://example.com/doc");

        expect(result.method).toBe("main");
        expect(result.content).toContain("<h1>Title</h1>");
        expect(result.content).toContain("Readable prose");
        expect(result.content).not.toContain("Sidebar link");
        expect(result.content).not.toContain("Copyright");
        expect(result.content).not.toContain("Docs");
    });

    test("a dominant article is the root, and the title heading above it comes along", () => {
        const html = page(`<main><h1>Post title</h1><article><p>${PROSE}</p><p>${PROSE}</p></article>
            <p>Short note.</p></main>`);
        const result = extractContent(html, "https://example.com/post");

        expect(result.method).toBe("article");
        expect(result.content.startsWith("<h1>Post title</h1>")).toBe(true);
        expect(result.content).not.toContain("Short note");
    });

    test("several article teasers of similar size keep the whole main", () => {
        const teaser = `<article><p>${PROSE}</p></article>`;
        const result = extractContent(page(`<main>${teaser}${teaser}${teaser}</main>`), "https://example.com/");

        expect(result.method).toBe("main");
    });

    test("a page without semantic elements is scored by its paragraphs", () => {
        const links = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">Menu entry number ${i}</a>`).join(" ");
        const html = page(`<div id="top"><div class="menu">${links}</div>
            <div class="content"><h2>Heading</h2><p>${PROSE}</p><p>${PROSE}</p><p>${PROSE}</p></div>
            <div class="bottom">${links}</div></div>`);
        const result = extractContent(html, "https://example.com/");

        expect(result.method).toBe("scored");
        expect(result.content).toContain("Heading");
        expect(result.content).not.toContain("Menu entry");
    });

    test("noise words match whole class words, and never inside code", () => {
        const html = page(`<main><p>${PROSE}</p>
            <div class="ad-slot">Buy now</div>
            <div class="download-button">Download notes stay</div>
            <div class="lead-in">Lead paragraph stays</div>
            <pre><code>let a = 1; <span class="token comment">// comment stays</span></code></pre>
            <section class="article-footer">Help improve this page</section></main>`);
        const { content } = extractContent(html, "https://example.com/");

        expect(content).not.toContain("Buy now");
        expect(content).toContain("Download notes stay");
        expect(content).toContain("Lead paragraph stays");
        expect(content).toContain("comment stays");
        expect(content).not.toContain("Help improve");
    });

    test("a hidden or noisy wrapper that holds the content is never removed", () => {
        const html = page(`<div aria-hidden="true"><div class="has-sidebar"><main><p>${PROSE}</p></main></div></div>`);

        expect(extractContent(html, "https://example.com/").content).toContain("Readable prose");
    });

    test("a long link list goes, a short see-also list stays", () => {
        const many = Array.from({ length: 12 }, (_, i) => `<li><a href="/l${i}">Language ${i}</a></li>`).join("");
        const html = page(`<main><h1>T</h1><ul id="langs">${many}</ul><p>${PROSE}</p><p>${PROSE}</p>
            <ul><li><a href="/a">See also one</a></li><li><a href="/b">See also two</a></li></ul></main>`);
        const { content } = extractContent(html, "https://example.com/");

        expect(content).not.toContain("Language 3");
        expect(content).toContain("See also two");
    });

    test("links and images become absolute, lazy images load, placeholders and fragments are handled", () => {
        const html = page(`<main><p>${PROSE} <a href="../other">rel</a> <a href="#part">frag</a></p>
            <img src="data:image/gif;base64,R0lGOD" data-src="/img/real.png" alt="lazy">
            <img src="data:image/gif;base64,R0lGOD" alt="placeholder">
            <img src="pic.png" alt="relative"></main>`);
        const { content } = extractContent(html, "https://example.com/docs/page");

        expect(content).toContain('href="https://example.com/other"');
        expect(content).toContain('href="#part"');
        expect(content).toContain('src="https://example.com/img/real.png"');
        expect(content).toContain('src="https://example.com/docs/pic.png"');
        expect(content).not.toContain("placeholder");
    });

    test("links and images resolve against a base element, relative or absolute, not the page URL", () => {
        const body = `<main><p>${PROSE} <a href="guide">rel</a> <a href="/root">root</a></p><img src="pic.png" alt="x"></main>`;
        const relative = extractContent(page(body, '<base href="/assets/">'), "https://example.com/docs/page").content;

        expect(relative).toContain('href="https://example.com/assets/guide"');
        expect(relative).toContain('href="https://example.com/root"');
        expect(relative).toContain('src="https://example.com/assets/pic.png"');

        const absolute = extractContent(
            page(body, '<base href="https://cdn.example.net/x/">'),
            "https://example.com/docs/page"
        ).content;

        expect(absolute).toContain('href="https://cdn.example.net/x/guide"');
        expect(absolute).toContain('src="https://cdn.example.net/x/pic.png"');
    });

    test("a base element with no href leaves the page URL as the base", () => {
        const html = page(`<main><p>${PROSE} <a href="guide">rel</a></p></main>`, '<base target="_blank">');
        const { content } = extractContent(html, "https://example.com/docs/page");

        expect(content).toContain('href="https://example.com/docs/guide"');
    });

    test("a language label above a code block goes, a heading above one stays", () => {
        const html = page(`<main><p>${PROSE}</p>
            <div class="example"><div class="header">http</div><pre class="brush: http"><code>GET /</code></pre></div>
            <h3>Python</h3><pre><code class="language-python">print(1)</code></pre></main>`);
        const { content } = extractContent(html, "https://example.com/");

        expect(content).not.toContain('<div class="header">http</div>');
        expect(content).toContain("<h3>Python</h3>");
    });

    test("metadata prefers og:title and reads author and date", () => {
        const head = `<title>Doc | Site</title><meta property="og:title" content="Doc">
            <meta name="author" content="Alice Example"><meta property="article:published_time" content="2026-01-02">`;
        const { meta } = extractContent(page(`<main><p>${PROSE}</p></main>`, head), "https://example.com/d");

        expect(meta).toEqual({
            title: "Doc",
            author: "Alice Example",
            publishedTime: "2026-01-02",
            url: "https://example.com/d",
        });
    });
});

describe("convertHtml", () => {
    const convert = (body: string, depth: "basic" | "advanced" = "basic") =>
        convertHtml(page(`<main>${body}</main>`, "<title>A: B</title>"), {
            url: "https://example.com/x",
            depth,
            engine: "turndown",
        }).markdown;

    test("code blocks keep their language, line breaks and backticks", () => {
        const markdown = convert(
            `<p>${PROSE}</p><pre><code class="language-ts">const a = 1;<br>const b = \`\`\`;</code></pre>`
        );

        expect(markdown).toContain("````typescript\nconst a = 1;\nconst b = ```;\n````");
    });

    test("inline code with a backtick gets a longer fence, permalink glyphs vanish", () => {
        const markdown = convert(`<h2>Setup <a href="#setup">#</a></h2><p>Run <code>a\`b</code> now. ${PROSE}</p>`);

        expect(markdown).toContain("## Setup\n");
        expect(markdown).toContain("``a`b``");
    });

    test("figures keep their caption, javascript links keep only their text", () => {
        const markdown = convert(
            `<p>${PROSE} <a href="javascript:void(0)">Click</a></p><figure><img src="/f.png" alt="Fig"><figcaption>The caption</figcaption></figure>`
        );

        expect(markdown).toContain("![Fig](https://example.com/f.png)\n*The caption*");
        expect(markdown).toContain(" Click");
        expect(markdown).not.toContain("javascript:");
    });

    test("a figure keeps every image, its paragraphs and a link inside its caption", () => {
        const markdown = convert(
            `<p>${PROSE}</p><figure><img src="/a.png" alt="A"><img src="/b.png" alt="B"><p>Explains both.</p><figcaption>Both <a href="/x">views</a></figcaption></figure>`
        );

        expect(markdown).toContain("![A](https://example.com/a.png)![B](https://example.com/b.png)");
        expect(markdown).toContain("Explains both.");
        expect(markdown).toContain("*Both [views](https://example.com/x)*");
    });

    test("a linked image in a figure stays a link", () => {
        const markdown = convert(
            `<p>${PROSE}</p><figure><a href="/big"><img src="/s.png" alt="S"></a><figcaption>Cap</figcaption></figure>`
        );

        expect(markdown).toContain("[![S](https://example.com/s.png)](https://example.com/big)\n*Cap*");
    });

    test("advanced depth adds front matter with quoted values", () => {
        const markdown = convert(`<p>${PROSE}</p>`, "advanced");

        expect(markdown.startsWith('---\ntitle: "A: B"\nurl: "https://example.com/x"\n---\n\n')).toBe(true);
    });
});

describe("markdown helpers", () => {
    const withCode = "Intro\n\n\n\n```bash\n# comment\n- item\n\n\n\necho hi   \n```\n\n\nEnd   ";

    test("normalising never touches code block content", () => {
        expect(normalizeMarkdown(withCode)).toBe("Intro\n\n```bash\n# comment\n- item\n\n\n\necho hi\n```\n\nEnd\n");
    });

    test("compacting collapses blank lines inside code only", () => {
        expect(compactCodeBlocks(withCode)).toBe("Intro\n\n\n\n```bash\n# comment\n- item\n\necho hi\n```\n\n\nEnd");
        expect(compactWhitespace("a  \t b\n\n\n\nc")).toBe("a b\n\nc");
    });

    test("validation ignores HTML inside code and flags it in prose", () => {
        expect(validateMarkdown("```html\n<div>ok</div>\n```\n\nUse `<span>` here.")).toEqual([]);
        expect(validateMarkdown("Text <div>left</div> <span>and</span> [](  )")).toEqual([
            "2 HTML tags remaining in output",
            "1 empty links found",
        ]);
        expect(validateMarkdown("```\nnever closed")).toEqual(["Unclosed code block detected"]);
    });
});

describe("readPage and the MCP door", () => {
    let server: ReturnType<typeof Bun.serve>;
    let otherServer: ReturnType<typeof Bun.serve>;
    let base: string;
    let seenHeader: string | null = null;
    let loopHits = 0;

    beforeAll(() => {
        otherServer = Bun.serve({
            port: 0,
            fetch(request) {
                return Response.json(Object.fromEntries(request.headers.entries()));
            },
        });
        server = Bun.serve({
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;

                if (path === "/moved") {
                    return Response.redirect(`${base}/docs/page`, 302);
                }

                if (path === "/to-other-origin") {
                    return Response.redirect(`http://127.0.0.1:${otherServer.port}/echo`, 302);
                }

                if (path === "/to-file") {
                    return new Response(null, { status: 302, headers: { location: "file:///etc/hosts" } });
                }

                if (path === "/loop") {
                    loopHits += 1;
                    return Response.redirect(`${base}/loop`, 302);
                }

                if (path === "/docs/page") {
                    seenHeader = request.headers.get("x-test");
                    const html = page(`<nav><a href="/">Home</a></nav>
                        <main><h1>Fixture</h1><p>${PROSE}</p><p><a href="sibling">Sibling</a></p>
                        <pre class="language-js"><code>let x = 1;</code></pre></main>`);
                    return new Response(`${html}\n\n\n\n   `, { headers: { "content-type": "text/html" } });
                }

                return new Response("gone", { status: 404, statusText: "Not Found" });
            },
        });
        base = `http://127.0.0.1:${server.port}`;
    });

    afterAll(() => {
        server.stop(true);
        otherServer.stop(true);
    });

    test("markdown mode follows redirects, sends headers and resolves links against the final URL", async () => {
        const result = await readPage({ url: `${base}/moved`, mode: "markdown", headers: { "x-test": "yes" } });

        expect(seenHeader).toBe("yes");
        expect(result.source).toBe(`${base}/docs/page`);
        expect(result.text).toStartWith("# Fixture\n");
        expect(result.text).toContain(`[Sibling](${base}/docs/sibling)`);
        expect(result.text).toContain("```javascript\nlet x = 1;\n```");
        expect(result.text).not.toContain("Home");
        expect(result.conversion?.method).toBe("main");
        expect(result.conversion?.issues).toEqual([]);
    });

    test("a redirect to another origin gets no caller headers, and the hop limit holds", async () => {
        const result = await readPage({
            url: `${base}/to-other-origin`,
            mode: "raw",
            headers: { "x-api-key": "secret", "x-test": "yes" },
        });
        const received = SafeJSON.parse(result.text);

        expect(received["x-api-key"]).toBeUndefined();
        expect(received["x-test"]).toBeUndefined();
        expect(received["user-agent"]).toContain("Mozilla");

        await expect(readPage({ url: `${base}/loop`, mode: "raw" })).rejects.toThrow("More than 5 redirects");
        expect(loopHits).toBe(6);
    });

    test("a redirect to a file: address is refused instead of read", async () => {
        await expect(readPage({ url: `${base}/to-file`, mode: "raw" })).rejects.toThrow("not an http or https address");
    });

    test("caller headers stay with the same origin, or the same host upgraded from http to https", () => {
        const url = (address: string) => new URL(address);

        expect(keepsHeaders(url("http://example.com/a"), url("http://example.com/b"))).toBe(true);
        expect(keepsHeaders(url("http://example.com/a"), url("https://example.com/a"))).toBe(true);
        expect(keepsHeaders(url("https://example.com/a"), url("http://example.com/a"))).toBe(false);
        expect(keepsHeaders(url("http://example.com/a"), url("https://www.example.com/a"))).toBe(false);
        expect(keepsHeaders(url("http://example.com:8080/a"), url("https://example.com/a"))).toBe(false);
        expect(keepsHeaders(url("http://example.com/a"), url("http://example.com:8080/a"))).toBe(false);
    });

    test("raw mode compacts whitespace and the token cap truncates", async () => {
        const raw = await readPage({ url: `${base}/docs/page`, mode: "raw", saveTokens: true });
        const capped = await readPage({ url: `${base}/docs/page`, mode: "raw", maxTokens: 5 });

        expect(raw.text).not.toContain("\n\n\n");
        expect(capped.truncated).toBe(true);
        expect(capped.tokens).toBe(5);
    });

    test("an error status throws, and an aborted signal stops the request", async () => {
        await expect(readPage({ url: `${base}/missing`, mode: "raw" })).rejects.toThrow("HTTP 404 Not Found");
        await expect(
            readPage({ url: `${base}/docs/page`, mode: "raw", signal: AbortSignal.abort() })
        ).rejects.toThrow();
    });

    test("the MCP server lists read-only tools and reports a removed engine by name", async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "web-reader-test", version: "1.0.0" });
        await Promise.all([client.connect(clientTransport), createWebReaderServer().connect(serverTransport)]);

        try {
            const { tools } = await client.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(["FetchWebMarkdown", "FetchWebRaw", "FetchJina"]);
            expect(tools[0].annotations?.readOnlyHint).toBe(true);
            expect(tools[0].inputSchema.properties?.engine).toMatchObject({ enum: ["turndown"] });

            const removed = await client.callTool({
                name: "FetchWebMarkdown",
                arguments: { url: `${base}/docs/page`, engine: "mdream" },
            });
            expect(removed.isError).toBe(true);
            expect(SafeJSON.stringify(removed.content)).toContain("Available engines: turndown");

            const ok = await client.callTool({ name: "FetchWebMarkdown", arguments: { url: `${base}/docs/page` } });
            expect(ok.isError).toBeFalsy();
            expect(ok._meta).toMatchObject({ truncated: false, engine: "turndown", method: "main" });
        } finally {
            await client.close();
        }
    });
});
