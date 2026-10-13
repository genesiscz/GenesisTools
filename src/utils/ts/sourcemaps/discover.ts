import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { parseSync } from "oxc-parser";

const { log } = logger.scoped("ts:sourcemaps:discover");
const prof = profiler.scope("sourcemaps");

interface EstreeNode {
    type: string;
    [key: string]: unknown;
}

function isNode(value: unknown): value is EstreeNode {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function* nodesOf(root: EstreeNode): Generator<EstreeNode> {
    const stack: EstreeNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as EstreeNode;
        yield node;
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (isNode(item)) {
                        stack.push(item);
                    }
                }
            } else if (isNode(value)) {
                stack.push(value);
            }
        }
    }
}

const ASSET_PATH = /^(?:\.{1,2}\/|\/)?[\w@~.%/-]+\.(?:m?js|css)(?:\?[\w=&.-]*)?$/;

/** Script, stylesheet and preload URLs of an HTML page, plus the code of its inline scripts. */
export function referencesInHtml(html: string): { refs: string[]; inlineScripts: string[] } {
    const refs: string[] = [];
    const inlineScripts: string[] = [];
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? "")?.[1];
        if (src) {
            refs.push(src);
        } else if (match[2]?.trim()) {
            inlineScripts.push(match[2]);
        }
    }

    for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
        const attrs = match[1] ?? "";
        const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? "";
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
        if (
            href &&
            /stylesheet|modulepreload|preload|prefetch/.test(rel) &&
            ASSET_PATH.test(href.split("#")[0] ?? "")
        ) {
            refs.push(href);
        }
    }

    return { refs, inlineScripts };
}

type Evaluated = string | undefined;

/** Evaluates the string concatenation of a chunk-name function for one id. Nothing outside that subset runs. */
function evaluateName(node: unknown, param: string, id: string): Evaluated {
    if (!isNode(node)) {
        return undefined;
    }

    switch (node.type) {
        case "Literal":
            return typeof node.value === "string" || typeof node.value === "number" ? String(node.value) : undefined;
        case "Identifier":
            return node.name === param ? id : undefined;
        case "ParenthesizedExpression":
            return evaluateName(node.expression, param, id);
        case "BinaryExpression": {
            if (node.operator !== "+") {
                return undefined;
            }

            const left = evaluateName(node.left, param, id);
            const right = evaluateName(node.right, param, id);
            return left === undefined || right === undefined ? undefined : left + right;
        }
        case "LogicalExpression": {
            if (node.operator !== "||") {
                return undefined;
            }

            return evaluateName(node.left, param, id) || evaluateName(node.right, param, id);
        }
        case "MemberExpression": {
            // `n.p` (the public path) is the deployment base: names resolve against it anyway.
            if (!node.computed && isNode(node.property) && node.property.name === "p") {
                return "";
            }

            if (!node.computed || !isNode(node.object) || node.object.type !== "ObjectExpression") {
                return undefined;
            }

            if (!isNode(node.property) || node.property.type !== "Identifier" || node.property.name !== param) {
                return undefined;
            }

            for (const property of (node.object.properties as unknown[]) ?? []) {
                if (isNode(property) && property.type === "Property" && keyOf(property.key) === id) {
                    return evaluateName(property.value, param, id);
                }
            }

            return undefined;
        }
        default:
            return undefined;
    }
}

function keyOf(key: unknown): string | null {
    if (!isNode(key)) {
        return null;
    }

    if (key.type === "Identifier") {
        return String(key.name);
    }

    return key.type === "Literal" ? String(key.value) : null;
}

/** The expression a one-parameter function returns, or null. */
function returnedExpression(fn: EstreeNode): unknown {
    if (fn.expression === true || (isNode(fn.body) && fn.body.type !== "BlockStatement")) {
        return fn.body;
    }

    const statements = isNode(fn.body) ? ((fn.body.body as unknown[]) ?? []) : [];
    const last = statements.at(-1);
    return statements.length === 1 && isNode(last) && last.type === "ReturnStatement" ? last.argument : null;
}

/**
 * The chunk file names a webpack or rspack runtime can load: its chunk-name function (`__webpack_require__.u`,
 * webpack 4's `jsonpScriptSrc`, `miniCssF` when it has a hash table) is evaluated for every chunk id in its
 * lookup tables. Paths come back as the runtime builds them, relative to the public path.
 */
export function chunkNamesFromRuntime(program: EstreeNode): string[] {
    const names = new Set<string>();
    for (const node of nodesOf(program)) {
        if (
            node.type !== "ArrowFunctionExpression" &&
            node.type !== "FunctionExpression" &&
            node.type !== "FunctionDeclaration"
        ) {
            continue;
        }

        const params = (node.params as unknown[]) ?? [];
        const param =
            params.length === 1 && isNode(params[0]) && params[0].type === "Identifier" ? String(params[0].name) : null;
        const body = param ? returnedExpression(node) : null;
        if (!param || !isNode(body) || body.type !== "BinaryExpression") {
            continue;
        }

        const ids = new Set<string>();
        for (const inner of nodesOf(body)) {
            if (
                inner.type === "MemberExpression" &&
                inner.computed &&
                isNode(inner.object) &&
                inner.object.type === "ObjectExpression" &&
                isNode(inner.property) &&
                inner.property.name === param
            ) {
                for (const property of (inner.object.properties as unknown[]) ?? []) {
                    const key = isNode(property) ? keyOf(property.key) : null;
                    if (key !== null) {
                        ids.add(key);
                    }
                }
            }
        }

        for (const id of ids) {
            const name = evaluateName(body, param, id);
            if (name && /\.(?:m?js|css)$/.test(name)) {
                names.add(name);
            }
        }
    }

    return [...names];
}

/** Module references of an ES bundle: static and dynamic imports, `new URL(..)` workers, and asset path arrays. */
export function moduleReferences(program: EstreeNode): string[] {
    const refs = new Set<string>();
    const literal = (value: unknown) => {
        if (
            isNode(value) &&
            value.type === "Literal" &&
            typeof value.value === "string" &&
            ASSET_PATH.test(value.value)
        ) {
            refs.add(value.value);
        }
    };
    for (const node of nodesOf(program)) {
        if (/^(Import|Export(All|Named))Declaration$/.test(node.type) || node.type === "ImportExpression") {
            literal(node.source);
        } else if (node.type === "NewExpression" && isNode(node.callee) && node.callee.name === "URL") {
            literal((node.arguments as unknown[])?.[0]);
        } else if (node.type === "ArrayExpression") {
            // Vite's preload table (`__vite__mapDeps`) lists dependencies as base-relative paths.
            for (const element of (node.elements as unknown[]) ?? []) {
                literal(element);
            }
        }
    }

    return [...refs];
}

/** The assets one JS file references, unresolved: chunk names from a runtime plus ES module references. */
export function referencesInScript(code: string, filename = "chunk.js"): { chunkNames: string[]; modules: string[] } {
    const parsed = parseSync(filename, code, { sourceType: "unambiguous", preserveParens: false });
    const program = parsed.program as unknown as EstreeNode;
    return { chunkNames: chunkNamesFromRuntime(program), modules: moduleReferences(program) };
}

/**
 * An asset URL under the deployment base, or null when it leaves it. `./x` and `../x` are relative to the file
 * that names them; a bare path (`static/js/1.js`, `assets/x.js`) is relative to the base, as runtimes build it.
 */
export function resolveReference(ref: string, fromUrl: string, baseUrl: string): string | null {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    let url: URL;
    try {
        url = /^(?:\.{1,2}\/|\/|https?:)/.test(ref) ? new URL(ref, fromUrl) : new URL(ref, base);
    } catch {
        return null;
    }

    url.hash = "";
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
        return null;
    }

    return url.href;
}

/**
 * Entry files that no page loads but that carry their own chunk table: a module federation container
 * (`remoteEntry.js`) loads chunks the host page never names. Probed under the base; a 404 costs one request.
 */
const WELL_KNOWN_ENTRIES = ["remoteEntry.js"];

export interface CrawledAssets {
    urls: string[];
    /** Downloaded bodies by URL, so the snapshot does not fetch them twice. */
    bodies: Map<string, string>;
    /** Last-Modified (ISO) by URL, for the files whose server sent one. */
    lastModified: Map<string, string>;
    notes: string[];
}

/**
 * Finds a deployment's JS and CSS without a manifest: the scripts and styles of its page(s), every chunk a
 * webpack/rspack runtime can load, and every module an ES bundle (Vite, Rollup) imports, followed transitively.
 * Only URLs under the base are kept; a reference that does not answer 200 is dropped.
 */
export async function crawlAssets(options: {
    baseUrl: string;
    pages?: string[];
    /** Script URLs to follow as well, e.g. files no page loads. */
    seeds?: string[];
    fetcher?: (url: string) => Promise<Response>;
    maxFiles?: number;
    concurrency?: number;
}): Promise<CrawledAssets> {
    const stop = prof.start("discover.crawl");
    const fetcher = options.fetcher ?? ((url: string) => fetch(url));
    const maxFiles = options.maxFiles ?? 5000;
    const notes: string[] = [];
    const bodies = new Map<string, string>();
    const lastModified = new Map<string, string>();
    const seen = new Set<string>();
    const queue: Array<{ url: string; from: string }> = [];
    const enqueue = (ref: string, from: string) => {
        const url = resolveReference(ref, from, options.baseUrl);
        if (url && !seen.has(url)) {
            seen.add(url);
            queue.push({ url, from });
        }
    };
    const scan = (code: string, url: string) => {
        try {
            const refs = referencesInScript(code, new URL(url).pathname.split("/").pop() || "chunk.js");
            for (const name of refs.chunkNames) {
                enqueue(name, options.baseUrl);
            }

            for (const ref of refs.modules) {
                enqueue(ref, url);
            }
        } catch (err) {
            log.debug({ err, url }, "script did not parse; its references are skipped");
        }
    };

    for (const seed of [...(options.seeds ?? []), ...WELL_KNOWN_ENTRIES]) {
        enqueue(seed, options.baseUrl);
    }

    for (const page of options.pages ?? [options.baseUrl]) {
        const response = await fetcher(page).catch((err: unknown) => {
            log.debug({ err, page }, "page fetch failed");
            return null;
        });
        if (!response?.ok) {
            notes.push(`page ${page} answered ${response?.status ?? "nothing"}`);
            continue;
        }

        const html = await response.text();
        const { refs, inlineScripts } = referencesInHtml(html);
        // A script or link attribute is relative to the page (or its <base href>), not to the deployment base:
        // `assets/main.js` on /app/ is /app/assets/main.js. Only bundler chunk tables resolve against the base.
        const baseHref = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
        const pageBase = baseHref && URL.canParse(baseHref, page) ? new URL(baseHref, page).href : page;
        for (const ref of refs) {
            let absolute: string;
            try {
                absolute = new URL(ref, pageBase).href;
            } catch (err) {
                log.debug({ err, ref, page }, "page reference is not a URL");
                continue;
            }

            enqueue(absolute, page);
        }

        for (const code of inlineScripts) {
            scan(code, page);
        }
    }

    while (queue.length > 0 && bodies.size < maxFiles) {
        const batch = queue.splice(0, options.concurrency ?? 8);
        await Promise.all(
            batch.map(async ({ url, from }) => {
                const response = await fetcher(url).catch((err: unknown) => {
                    log.debug({ err, url }, "asset fetch failed");
                    return null;
                });
                if (!response?.ok) {
                    log.debug({ url, from, status: response?.status }, "referenced asset is not served");
                    return;
                }

                const code = await response.text();
                bodies.set(url, code);
                const modified = Date.parse(response.headers.get("last-modified") ?? "");
                if (!Number.isNaN(modified)) {
                    lastModified.set(url, new Date(modified).toISOString());
                }

                if (/\.m?js$/.test(new URL(url).pathname)) {
                    scan(code, url);
                }
            })
        );
    }

    if (queue.length > 0) {
        notes.push(`stopped at ${maxFiles} files; ${queue.length} references were not followed`);
    }

    const urls = [...bodies.keys()].sort();
    stop();
    log.info(
        { baseUrl: options.baseUrl, files: urls.length, tried: seen.size },
        "assets discovered without a manifest"
    );
    return { urls, bodies, lastModified, notes };
}
