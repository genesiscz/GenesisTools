import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetInitState, initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { runCaptureFixture } from "@app/shops/lib/capture-fixture";
import { SafeJSON } from "@app/utils/json";

describe("runCaptureFixture", () => {
    let tmpRoot: string;

    beforeEach(() => {
        tmpRoot = mkdtempSync(join(tmpdir(), "shops-fixture-"));
        ShopRegistry.reset();
        __resetInitState();
        initShopRegistry();
    });

    afterEach(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("writes raw HTML to <fixturesDir>/<shop>/<slug>.html when shop is HTML-only", async () => {
        const stubFetcher = async (): Promise<{ status: number; body: string; contentType: string }> => ({
            status: 200,
            body: "<html><body>fixture-stub</body></html>",
            contentType: "text/html",
        });

        const result = await runCaptureFixture({
            shop: "knihydobrovsky.cz",
            url: "https://www.knihydobrovsky.cz/kniha/test-1234567",
            fixturesDir: tmpRoot,
            fetcher: stubFetcher,
        });

        expect(result.writtenPaths.length).toBe(1);
        expect(existsSync(result.writtenPaths[0])).toBe(true);
        expect(readFileSync(result.writtenPaths[0], "utf8")).toContain("fixture-stub");
        expect(result.writtenPaths[0]).toMatch(/knihydobrovsky\.cz\/.+\.html$/);
    });

    it("writes evaluate output as JSON for WebView shops", async () => {
        const stubWebViewFetcher = async (): Promise<{ html: string; evaluated: unknown }> => ({
            html: "<html>SPA</html>",
            evaluated: { id: "d1", name: "Test", price: { current: 100, currency: "CZK" } },
        });

        const result = await runCaptureFixture({
            shop: "alza.cz",
            url: "https://www.alza.cz/test-d1.htm",
            fixturesDir: tmpRoot,
            webviewFetcher: stubWebViewFetcher,
        });

        expect(result.writtenPaths.length).toBe(2);
        const jsonPath = result.writtenPaths.find((p) => p.endsWith(".evaluate.json"));
        expect(jsonPath).toBeDefined();
        if (jsonPath !== undefined) {
            const parsed = SafeJSON.parse(readFileSync(jsonPath, "utf8")) as { id: string };
            expect(parsed.id).toBe("d1");
        }
    });

    it("rejects 4xx HTTP status with a clear error", async () => {
        await expect(
            runCaptureFixture({
                shop: "knihydobrovsky.cz",
                url: "https://example/notfound",
                fixturesDir: tmpRoot,
                fetcher: async () => ({ status: 404, body: "", contentType: "text/html" }),
            })
        ).rejects.toThrow(/HTTP 404/);
    });

    it("rejects unknown shop with a clear error", async () => {
        await expect(
            runCaptureFixture({
                shop: "doesnotexist.cz",
                url: "https://x",
                fixturesDir: tmpRoot,
                fetcher: async () => ({ status: 200, body: "", contentType: "text/html" }),
            })
        ).rejects.toThrow(/unknown shop/i);
    });
});
