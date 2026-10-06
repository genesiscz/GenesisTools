import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { injectTtydMobileShell, shouldInjectTtydMobileShell } from "@app/dev-dashboard/lib/ttyd/mobile-shell";

describe("ttyd mobile-shell", () => {
    test("shouldInjectTtydMobileShell only patches ttyd HTML documents, and never a HEAD probe", () => {
        const page = "/ttyd/550e8400-e29b-41d4-a716-446655440000/";
        expect(shouldInjectTtydMobileShell({ method: "GET", pathname: page, contentType: "text/html" })).toBe(true);
        expect(
            shouldInjectTtydMobileShell({ method: "GET", pathname: `${page}app.js`, contentType: "text/javascript" })
        ).toBe(false);
        expect(shouldInjectTtydMobileShell({ method: "GET", pathname: "/cmux", contentType: "text/html" })).toBe(false);
        expect(shouldInjectTtydMobileShell({ method: "HEAD", pathname: page, contentType: "text/html" })).toBe(false);
    });

    test("injectTtydMobileShell replaces viewport and injects shell assets", () => {
        const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`;
        const patched = injectTtydMobileShell(html);

        expect(patched).toContain("maximum-scale=1");
        expect(patched).toContain('id="dd-ttyd-mobile-shell"');
        expect(patched).toContain("__ddTtydScroll");
        expect(patched).toContain("__ddTtydScrollPage");
        expect(patched).toContain("__ddTtydPaste");
        expect(patched).toContain("term.paste(text)");
        expect(patched).toContain("dd-ttyd-paste");
        expect(patched).toContain("function visibleRows()");
        expect(patched).toContain("WHEEL_LINES_PER_TICK");
        expect(patched).toContain("coreMouseService");
        expect(patched).toContain("triggerMouseEvent");
        expect(patched).toContain("direction < 0 ? 0 : 1");
        expect(patched).toContain("scrollLines");
        expect(patched).toContain("touch-action: none");
    });

    test("message receiver accepts only the exact same-origin parent", () => {
        const html = injectTtydMobileShell("<html><head></head><body></body></html>");
        const script = html.match(/<script id="dd-ttyd-mobile-shell-js">([\s\S]*?)<\/script>/)?.[1];
        expect(script).toBeString();

        let listener: ((event: { data: unknown; origin: string; source: unknown }) => void) | undefined;
        const pasted: string[] = [];
        const parent = {};
        const window = {
            parent,
            location: { origin: "https://dashboard.test" },
            term: { paste: (text: string) => pasted.push(text) },
            addEventListener: (type: string, handler: typeof listener) => {
                if (type === "message") {
                    listener = handler;
                }
            },
            setTimeout: () => 0,
        };
        const document = { querySelector: () => null, addEventListener: () => undefined };
        runInNewContext(script!, { window, document, Math, Number });
        expect(listener).toBeFunction();

        listener!({
            data: { type: "dd-ttyd-paste", text: "foreign" },
            origin: "https://attacker.test",
            source: parent,
        });
        listener!({
            data: { type: "dd-ttyd-paste", text: "sibling" },
            origin: "https://dashboard.test",
            source: {},
        });
        listener!({
            data: { type: "dd-ttyd-paste", text: "normal" },
            origin: "https://dashboard.test",
            source: parent,
        });
        listener!({
            data: { type: "dd-ttyd-paste", text: 42 },
            origin: "https://dashboard.test",
            source: parent,
        });

        expect(pasted).toEqual(["normal"]);
    });
});
