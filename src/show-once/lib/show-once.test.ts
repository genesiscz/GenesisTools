import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { connectSession } from "./browser";
import { moveVerified } from "./files";
import { expand, parseRecipe, type Recipe, resolvedInputs, safeUrl } from "./recipe";
import { runRecipe } from "./runner";
import { recipeFromRecording, ShowOnceService } from "./service";

const evidence = { eventId: "action-1", url: "http://localhost:8000/", at: 1, detail: "Observed input change" };
export function sampleRecipe(): Recipe {
    return parseRecipe({
        version: 1,
        id: "example",
        title: "Customer report",
        createdAt: "2026-10-06T00:00:00Z",
        allowedOrigins: ["http://localhost:8000"],
        parameters: [{ name: "customer", label: "Customer", secret: false }],
        steps: [
            {
                id: "a",
                title: "Enter customer",
                evidence,
                enabled: true,
                kind: "fill",
                locator: { kind: "testId", value: "customer" },
                pageUrl: "http://localhost:8000/",
                value: "{{customer}}",
            },
        ],
    });
}
describe("portable recipe data", () => {
    test("expands explicit values without evaluating code", () => {
        expect(expand("{{customer}}-{{month}}.csv", { customer: "shop", month: "2026-10" })).toBe("shop-2026-10.csv");
        expect(expand("{{customer}}", { customer: "$(echo never-executed)" })).toBe("$(echo never-executed)");
        expect(() => expand("{{missing}}", {})).toThrow("Missing input");
    });
    test("rejects unknown executable fields and versions", () => {
        expect(() => parseRecipe({ ...sampleRecipe(), shell: "ignored?" })).toThrow();
        expect(() => parseRecipe({ ...sampleRecipe(), version: 2 })).toThrow();
    });
    test("refuses stored secret defaults and duplicate step IDs", () => {
        expect(() =>
            parseRecipe({
                ...sampleRecipe(),
                parameters: [{ name: "customer", label: "Password", secret: true, defaultValue: "secret" }],
            })
        ).toThrow();
        const recipe = sampleRecipe();
        expect(() => parseRecipe({ ...recipe, steps: [recipe.steps[0], recipe.steps[0]] })).toThrow(
            "Duplicate step IDs"
        );
    });
    test("requires declared parameters and runtime secrets", () => {
        const recipe = sampleRecipe();
        expect(() => resolvedInputs(recipe, {})).toThrow("Missing input");
        expect(() => parseRecipe({ ...recipe, parameters: [] })).toThrow("Unknown parameter");
        expect(resolvedInputs(recipe, { customer: "shop" })).toEqual({ customer: "shop" });
    });
    test("secrets can only be whole runtime fill values", () => {
        const recipe = sampleRecipe();
        const parameter = { name: "customer", label: "Secret", secret: true };
        expect(parseRecipe({ ...recipe, parameters: [parameter] }).parameters[0].defaultValue).toBeUndefined();
        expect(() =>
            parseRecipe({
                ...recipe,
                parameters: [parameter],
                steps: [{ ...recipe.steps[0], pageUrl: "https://example.com/?token={{customer}}" }],
            })
        ).toThrow("Secret inputs");
        expect(() =>
            parseRecipe({
                ...recipe,
                parameters: [parameter],
                steps: [{ ...recipe.steps[0], value: "prefix-{{customer}}" }],
            })
        ).toThrow("Secret inputs");
    });
    test("declared secret fills reject retained literal source values", () => {
        const recipe = sampleRecipe();
        expect(() =>
            parseRecipe({
                ...recipe,
                parameters: [{ name: "customer", label: "Secret", secret: true }],
                steps: [{ ...recipe.steps[0], evidence: { ...evidence, recordedValue: "invented-private-value" } }],
            })
        ).toThrow("cannot retain");
    });
    test("parameterization and target repair preserve original recording evidence", () => {
        const recorded = recipeFromRecording({
            title: "Recorded input",
            downloads: [],
            snapshot: {
                initialUrl: "http://localhost:8000/",
                actions: [
                    {
                        id: "typed",
                        kind: "fill",
                        value: "personal",
                        locator: { kind: "testId", value: "customer" },
                        excluded: false,
                        at: 1,
                    },
                ],
                evidence: [],
            },
        });
        const step = recorded.steps[1];
        const edited = parseRecipe({
            ...recorded,
            parameters: [{ name: "customer", label: "Customer", secret: false }],
            steps: [
                recorded.steps[0],
                { ...step, value: "{{customer}}", locator: { kind: "testId", value: "repaired-customer" } },
            ],
        });
        expect(edited.steps[1].evidence.recordedValue).toBe("personal");
        expect(edited.steps[1].evidence.recordedLocator?.value).toBe("customer");
    });
    test("CSS fallback requires evidence and identity remains literal", () => {
        const recipe = sampleRecipe();
        expect(() =>
            parseRecipe({
                ...recipe,
                steps: [{ ...recipe.steps[0], locator: { kind: "css", value: "input:nth-child(1)" } }],
            })
        ).toThrow("identity evidence");
        expect(() =>
            parseRecipe({
                ...recipe,
                steps: [{ ...recipe.steps[0], locator: { kind: "testId", value: "{{customer}}" } }],
            })
        ).toThrow("cannot be parameterized");
    });
    test("recording preserves omitted-sensitive-input warnings as unsupported steps", () => {
        const recipe = recipeFromRecording({
            title: "Sensitive task",
            downloads: [],
            snapshot: {
                initialUrl: "http://localhost:8000/",
                actions: [],
                evidence: [
                    { id: "warning1", kind: "warning", text: "Sensitive input omitted", excluded: false, at: 1 },
                ],
            },
        });
        expect(
            recipe.steps.some((step) => step.kind === "unsupported" && step.reason === "Sensitive input omitted")
        ).toBe(true);
        expect(recipe.parameters).toEqual([]);
    });
    test("enabled unsupported evidence prevents any browser connection or action", async () => {
        const recipe = recipeFromRecording({
            title: "Unsupported task",
            downloads: [],
            snapshot: {
                initialUrl: "http://localhost:8000/",
                actions: [],
                evidence: [{ id: "frame", kind: "warning", text: "Iframe action omitted", excluded: false, at: 1 }],
            },
        });
        let connections = 0;
        const receipt = await runRecipe({
            recipe,
            inputs: {},
            port: 8000,
            targetId: "explicit",
            downloadDirectory: "/unused",
            connect: async () => {
                connections++;
                throw new Error("Must not open browser");
            },
        });
        expect(connections).toBe(0);
        expect(receipt.status).toBe("failed");
        expect(receipt.events[0].status).toBe("refused");
        expect(receipt.events[0].message).toBe("Iframe action omitted");
    });
    test("multiple possible clicks preserve trigger uncertainty for explicit review", () => {
        const locator = { kind: "testId" as const, value: "button" };
        const recipe = recipeFromRecording({
            title: "Ambiguous download",
            downloads: [{ filename: "report.csv", url: "http://localhost:8000/report.csv", at: 10 }],
            snapshot: {
                initialUrl: "http://localhost:8000/",
                actions: [
                    { id: "first", kind: "click", locator, excluded: false, at: 1 },
                    { id: "second", kind: "click", locator, excluded: false, at: 2 },
                ],
                evidence: [],
            },
        });
        expect(recipe.steps.some((step) => step.kind === "unsupported" && step.id === "download-review")).toBe(true);
        expect(recipe.steps.some((step) => step.kind === "download")).toBe(false);
    });
    test("runtime inputs require own properties rather than inherited constructor values", () => {
        const recipe = sampleRecipe();
        const named = parseRecipe({
            ...recipe,
            parameters: [{ name: "constructor", label: "Constructor", secret: false }],
            steps: [{ ...recipe.steps[0], value: "{{constructor}}" }],
        });
        expect(() => resolvedInputs(named, {})).toThrow("Missing input: constructor");
        expect(resolvedInputs(named, { constructor: "literal" })).toEqual({ constructor: "literal" });
    });
    test("portable save refuses data larger than its reopen limit before writing", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
        const file = join(root, "large.showonce.json");
        const sample = sampleRecipe();
        const value = "x".repeat(8000);
        const large = parseRecipe({
            ...sample,
            steps: Array.from({ length: 140 }, (_entry, index) => ({
                ...sample.steps[0],
                id: `step-${index}`,
                value,
                evidence: { ...evidence, recordedValue: value },
            })),
        });
        await expect(new ShowOnceService().dispatch({ op: "save", recipe: large, file })).rejects.toThrow("2 MB");
        expect(await Bun.file(file).exists()).toBe(false);
    });
    test("refuses credentials and non-web navigation", () => {
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://alice:secret@example.com"]) {
            expect(() => safeUrl(url)).toThrow();
        }
        expect(safeUrl("https://example.com/report").origin).toBe("https://example.com");
    });
});
describe("verified file moves", () => {
    test("checks content/hash then moves and refuses collisions", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
        const destination = join(root, "destination");
        await mkdir(destination);
        const source = join(root, "download.csv");
        await Bun.write(source, "customer,month\nshop,2026-10\n");
        let dispatched = 0;
        const receipt = await moveVerified({
            source,
            destination,
            filename: "shop.csv",
            contains: ["shop,2026-10"],
            onDispatch: () => {
                dispatched++;
            },
        });
        expect(receipt.sha256).toHaveLength(64);
        expect(await Bun.file(source).exists()).toBe(false);
        expect(await Bun.file(receipt.path).text()).toContain("shop,2026-10");
        expect(dispatched).toBe(1);
        await Bun.write(source, "new data");
        await expect(
            moveVerified({
                source,
                destination,
                filename: "shop.csv",
                contains: [],
                onDispatch: () => {
                    dispatched++;
                },
            })
        ).rejects.toThrow("already exists");
        expect(await Bun.file(source).text()).toBe("new data");
        expect(dispatched).toBe(1);
    });
    test("refuses mismatched content, traversal and cancellation before mutation", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
        const source = join(root, "download.csv");
        await Bun.write(source, "shop data");
        const base = {
            source,
            destination: root,
            filename: "result.csv",
            contains: [],
            onDispatch: () => {
                throw Error("Must not dispatch");
            },
        };
        await expect(moveVerified({ ...base, contains: ["wrong customer"] })).rejects.toThrow("content check failed");
        await expect(moveVerified({ ...base, filename: "../escape.csv" })).rejects.toThrow("traversal");
        await expect(moveVerified({ ...base, signal: AbortSignal.abort() })).rejects.toThrow();
        expect(await Bun.file(source).exists()).toBe(true);
        expect(await Bun.file(join(root, "result.csv")).exists()).toBe(false);
    });
});

test("attachment setup aborts a pending domain call and normal attachment still succeeds", async () => {
    let hold = true;
    let reached: () => void = () => {};
    const ready = new Promise<void>((resolveReady) => {
        reached = resolveReady;
    });
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, host) {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/json/list") {
                return Response.json([
                    {
                        id: "fixture-tab",
                        type: "page",
                        title: "Fixture",
                        url: "https://example.com/",
                        webSocketDebuggerUrl: `ws://127.0.0.1:${host.port}/page`,
                    },
                ]);
            }
            if (pathname === "/json/version") {
                return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${host.port}/browser` });
            }
            if (host.upgrade(request)) {
                return;
            }
            return new Response("Not found", { status: 404 });
        },
        websocket: {
            message(socket, raw) {
                const request = z
                    .object({ id: z.number(), method: z.string() })
                    .parse(SafeJSON.parse(String(raw), { strict: true }));
                if (request.method === "Page.enable" && hold) {
                    reached();
                    return;
                }
                socket.send(
                    SafeJSON.stringify(
                        {
                            id: request.id,
                            result:
                                request.method === "Page.getFrameTree"
                                    ? { frameTree: { frame: { id: "fixture-frame" } } }
                                    : {},
                        },
                        { strict: true }
                    )
                );
            },
        },
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const blocked = connectSession({
            port: server.port!,
            targetId: "fixture-tab",
            directory: "/unused",
            signal: controller.signal,
        });
        const outcome = blocked.then(
            (session) => ({ session }),
            (error: unknown) => ({ error })
        );
        try {
            await Promise.race([
                ready,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Domain call not reached")), 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        const start = performance.now();
        controller.abort(new Error("Setup cancelled"));
        const observed = await outcome;
        if ("session" in observed) {
            await observed.session.close();
            throw new Error("Expected cancelled attachment");
        }
        expect(observed.error).toBeInstanceOf(Error);
        if (!(observed.error instanceof Error)) {
            throw new Error("Cancellation error was missing");
        }
        expect(observed.error.message).toContain("Setup cancelled");
        expect(performance.now() - start).toBeLessThan(500);
        hold = false;
        const normal = await connectSession({ port: server.port!, targetId: "fixture-tab", directory: "/unused" });
        expect(normal.page.target.id).toBe("fixture-tab");
        await normal.close();
    } finally {
        controller.abort();
        server.stop(true);
    }
});
