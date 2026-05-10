import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { WebView } from "@app/utils/WebView";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";

const log = logger.child({ component: "shops:capture-fixture" });

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const SHOP_NEEDS_WEBVIEW = new Set(["alza.cz"]);

const SHOP_EVALUATE_DEFAULTS: Record<string, string> = {
    "alza.cz": "window.__ALZA_PRODUCT_DATA__",
};

export interface CaptureFixtureFetcherResult {
    status: number;
    body: string;
    contentType: string;
}

export interface CaptureFixtureWebViewResult {
    html: string;
    evaluated: unknown;
}

export interface CaptureFixtureResult {
    writtenPaths: string[];
}

export interface RunCaptureFixtureOptions {
    shop: string;
    url: string;
    fixturesDir: string;
    fetcher?: (url: string) => Promise<CaptureFixtureFetcherResult>;
    webviewFetcher?: (url: string) => Promise<CaptureFixtureWebViewResult>;
    evaluateExpr?: string;
}

async function realHttpFetcher(url: string): Promise<CaptureFixtureFetcherResult> {
    const resp = await fetch(url, { headers: { "User-Agent": DEFAULT_USER_AGENT } });
    const body = await resp.text();
    return {
        status: resp.status,
        body,
        contentType: resp.headers.get("content-type") ?? "text/html",
    };
}

async function realWebViewFetcher(url: string, expr: string): Promise<CaptureFixtureWebViewResult> {
    const wv = new WebView({
        toolName: "shops",
        profileKey: "capture-fixture",
        dataStore: "ephemeral",
        consolePipe: false,
        width: 1280,
        height: 900,
    });

    try {
        await wv.navigate(url, { timeoutMs: 25_000 });
        await wv.waitForSelector("body");
        const evaluated = await wv.evaluate(expr, { timeoutMs: 10_000 });
        const html = await wv.evaluate<string>("document.documentElement.outerHTML");
        return { html, evaluated };
    } finally {
        wv.close();
    }
}

function deriveSlug(url: string): string {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\//g, "_");
    return path || "root";
}

export async function runCaptureFixture(opts: RunCaptureFixtureOptions): Promise<CaptureFixtureResult> {
    const registry = ShopRegistry.get();
    const client = registry.forShop(opts.shop);
    if (!client) {
        const known = registry
            .all()
            .map((c) => c.shopOrigin)
            .join(", ");
        throw new Error(`unknown shop: ${opts.shop} (registry has: ${known || "<empty>"})`);
    }

    const slug = deriveSlug(opts.url);
    const baseDir = join(opts.fixturesDir, client.shopOrigin);
    mkdirSync(baseDir, { recursive: true });

    const written: string[] = [];

    if (SHOP_NEEDS_WEBVIEW.has(client.shopOrigin)) {
        const expr = opts.evaluateExpr ?? SHOP_EVALUATE_DEFAULTS[client.shopOrigin] ?? "({})";
        const fetcher = opts.webviewFetcher ?? ((url: string) => realWebViewFetcher(url, expr));
        const { html, evaluated } = await fetcher(opts.url);
        const htmlPath = join(baseDir, `${slug}.html`);
        const jsonPath = join(baseDir, `${slug}.evaluate.json`);
        writeFileSync(htmlPath, html);
        writeFileSync(jsonPath, SafeJSON.stringify(evaluated, null, 2));
        written.push(htmlPath, jsonPath);
        log.info({ shop: client.shopOrigin, htmlPath, jsonPath }, "fixture written (WebView)");
    } else {
        const fetcher = opts.fetcher ?? realHttpFetcher;
        const { status, body, contentType } = await fetcher(opts.url);
        if (status >= 400) {
            throw new Error(`HTTP ${status} fetching ${opts.url}; refusing to write fixture`);
        }

        const ext = contentType.includes("json") ? "json" : "html";
        const path = join(baseDir, `${slug}.${ext}`);
        writeFileSync(path, body);
        written.push(path);
        log.info({ shop: client.shopOrigin, path, status }, "fixture written (HTTP)");
    }

    return { writtenPaths: written };
}
