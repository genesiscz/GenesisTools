import { describe, expect, test } from "bun:test";
import { injectTtydMobileShell, shouldInjectTtydMobileShell } from "@app/dev-dashboard/lib/ttyd/mobile-shell";

describe("ttyd mobile-shell", () => {
    test("shouldInjectTtydMobileShell only patches ttyd HTML documents", () => {
        expect(shouldInjectTtydMobileShell("/ttyd/550e8400-e29b-41d4-a716-446655440000/", "text/html")).toBe(true);
        expect(
            shouldInjectTtydMobileShell("/ttyd/550e8400-e29b-41d4-a716-446655440000/app.js", "text/javascript")
        ).toBe(false);
        expect(shouldInjectTtydMobileShell("/cmux", "text/html")).toBe(false);
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
});
