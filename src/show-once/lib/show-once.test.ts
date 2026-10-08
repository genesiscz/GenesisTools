import { describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import * as recording from "@app/chrome-devtools/lib/action-recording";
import { SafeJSON } from "@genesiscz/utils/json";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import * as browserModule from "./browser";
import { connectSession } from "./browser";
import { moveVerified } from "./files";
import { downloadOrigin, expand, parseRecipe, type Recipe, resolvedInputs, safeUrl } from "./recipe";
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
        for (const value of ["a}}b", "a{{b", "{{other}}", "{{customer}}", "$&$$"]) {
            expect(expand("{{customer}}", { customer: value })).toBe(value);
        }
        expect(() => expand("{{bad-reference}}", {})).toThrow("Malformed");
        expect(() => expand("{{customer}}}}", { customer: "shop" })).toThrow("Malformed");
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

function cdpFixture(
    options: {
        evaluate?: (expression: string) => unknown;
        onCommand?: (method: string, resume: () => void) => boolean | undefined;
    } = {}
) {
    const routing: string[] = [];
    const identity = crypto.randomUUID();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, host) {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/json/list") {
                return Response.json(
                    ["first", "second"].map((id) => ({
                        id,
                        type: "page",
                        title: id,
                        url: "https://example.com/",
                        webSocketDebuggerUrl: `ws://127.0.0.1:${host.port}/${id}`,
                    }))
                );
            }
            if (pathname === "/json/version") {
                return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${host.port}/browser/${identity}` });
            }
            if (host.upgrade(request)) {
                return;
            }
            return new Response("Not found", { status: 404 });
        },
        websocket: {
            message(socket, raw) {
                const request = z
                    .object({ id: z.number(), method: z.string(), params: z.record(z.string(), z.unknown()) })
                    .parse(SafeJSON.parse(String(raw), { strict: true }));
                const resume = () => socket.send(SafeJSON.stringify({ id: request.id, result: {} }, { strict: true }));
                if (options.onCommand?.(request.method, resume) === false) {
                    return;
                }
                let result: unknown = {};
                if (request.method === "Browser.setDownloadBehavior") {
                    routing.push(String(request.params.behavior));
                }
                if (request.method === "Page.getFrameTree") {
                    result = { frameTree: { frame: { id: "fixture-frame" } } };
                }
                if (request.method === "Runtime.evaluate") {
                    const expression = String(request.params.expression);
                    try {
                        result = {
                            result: {
                                value:
                                    options.evaluate?.(expression) ??
                                    !expression.includes("typeof window.__genesisRecordingCleanup"),
                            },
                        };
                    } catch (error) {
                        result = { exceptionDetails: { text: String(error) } };
                    }
                }
                if (request.method === "Page.addScriptToEvaluateOnNewDocument") {
                    result = { identifier: "fixture-script" };
                }
                socket.send(SafeJSON.stringify({ id: request.id, result }, { strict: true }));
            },
        },
    });
    return { server, routing };
}

test("password changes between probe or focus and mutation refuse literals and preserve runtime-secret fill", async () => {
    let changeBetweenCalls = true;
    let changeOnFocus = false;
    let changePageOnFocus = false;
    let redirectFocus = false;
    let focused: unknown;
    let keyEvents = 0;
    const location = { href: "https://example.com/" };
    const input = {
        tagName: "INPUT",
        type: "text",
        value: "",
        disabled: false,
        getAttribute: (name: string) => (name === "data-testid" ? "customer" : null),
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
        closest: () => null,
        contains: () => false,
        focus: () => {
            focused = redirectFocus ? { tagName: "BUTTON", type: "button" } : input;
            if (changeOnFocus) {
                input.type = "password";
            }
            if (changePageOnFocus) {
                location.href = "https://example.com/changed";
            }
        },
        scrollIntoView: () => {},
        dispatchEvent: () => {},
    };
    let writes = 0;
    const prototype = Object.create(null);
    Object.defineProperty(prototype, "value", {
        set(value: string) {
            writes++;
            input.value = value;
        },
    });
    const { server } = cdpFixture({
        onCommand: (method) => {
            if (method === "Input.dispatchKeyEvent") {
                keyEvents++;
            }
        },
        evaluate: (expression) => {
            const value: unknown = runInNewContext(expression, {
                location,
                window: {},
                document: {
                    querySelectorAll: () => [input],
                    elementFromPoint: () => input,
                    get activeElement() {
                        return focused;
                    },
                },
                getComputedStyle: () => ({ visibility: "visible", display: "block" }),
                HTMLInputElement: { prototype },
                Event: class {},
            });
            if (changeBetweenCalls && expression.includes("return result;")) {
                input.type = "password";
            }
            return value;
        },
    });
    const browser = await connectSession({ port: server.port!, targetId: "first", directory: "/unused" });
    const base = {
        locator: { kind: "testId" as const, value: "customer" },
        expectedUrl: "https://example.com/",
        value: "literal",
        onDispatch: () => {},
    };
    try {
        await expect(browser.action({ ...base, kind: "fill" })).rejects.toThrow("Target changed");
        expect(writes).toBe(0);
        input.type = "text";
        await expect(browser.action({ ...base, kind: "press", value: "Enter" })).rejects.toThrow("Target changed");
        expect(writes).toBe(0);
        await expect(browser.action({ ...base, kind: "fill", secret: true })).resolves.toBe(
            "Exact value readback matched."
        );
        expect(writes).toBe(1);
        expect(input.value).toBe("literal");
        changeBetweenCalls = false;
        changeOnFocus = true;
        input.type = "text";
        await expect(browser.action({ ...base, kind: "fill" })).rejects.toThrow("Target changed");
        expect(writes).toBe(1);
        input.type = "text";
        await expect(browser.action({ ...base, kind: "press", value: "Enter" })).rejects.toThrow("Target changed");
        expect(keyEvents).toBe(0);
        input.type = "text";
        await expect(browser.action({ ...base, kind: "fill", secret: true })).resolves.toBe(
            "Exact value readback matched."
        );
        expect(writes).toBe(2);
        changePageOnFocus = true;
        await expect(browser.action({ ...base, kind: "fill", secret: true })).rejects.toThrow("Target changed");
        expect(writes).toBe(2);
        location.href = "https://example.com/";
        input.type = "text";
        await expect(browser.action({ ...base, kind: "press", value: "Enter" })).rejects.toThrow("Target changed");
        expect(keyEvents).toBe(0);
        changePageOnFocus = false;
        changeOnFocus = false;
        location.href = "https://example.com/";
        input.type = "text";
        redirectFocus = true;
        await expect(browser.action({ ...base, kind: "press", value: "Enter" })).rejects.toThrow("Target changed");
        expect(keyEvents).toBe(0);
        redirectFocus = false;
        await expect(browser.action({ ...base, kind: "press", value: "Enter" })).resolves.toContain("Key dispatched");
        expect(keyEvents).toBe(2);
    } finally {
        await browser.close();
        server.stop(true);
    }
});

test("routing lease rejects another tab and releases only the owning browser session", async () => {
    const { server, routing } = cdpFixture();
    const connect = (targetId: string) => connectSession({ port: server.port!, targetId, directory: "/unused" });
    const first = await connect("first");
    const second = await connect("second");
    let third: Awaited<ReturnType<typeof connect>> | undefined;
    try {
        await first.configureDownloads();
        const script = `import { connectSession, Refusal } from ${SafeJSON.stringify(join(import.meta.dir, "browser.ts"), { strict: true })};
            const browser = await connectSession({port:${server.port},targetId:'second',directory:'/unused'});
            try { await browser.configureDownloads(); process.exitCode = 43; }
            catch (error) { process.exitCode = error instanceof Refusal ? 42 : 44; }
            finally { await browser.close(); }`;
        const competingProcess = Bun.spawn([process.execPath, "--eval", script], {
            env: { ...process.env, GENESIS_TOOLS_HOME: dirname(genesisToolsDir()) },
            stdout: "ignore",
            stderr: "pipe",
            signal: AbortSignal.timeout(3000),
        });
        const competingErrors = new Response(competingProcess.stderr).text();
        expect(await competingProcess.exited).toBe(42);
        expect(await competingErrors).toBe("");
        await expect(second.configureDownloads()).rejects.toThrow("Another workflow owns");
        await second.close();
        expect(routing).toEqual(["allowAndName"]);
        await first.close();
        expect(routing).toEqual(["allowAndName", "default"]);
        third = await connect("second");
        await third.configureDownloads({ named: false, recordingAdmitted: true });
        expect(routing).toEqual(["allowAndName", "default", "allow"]);
    } finally {
        await first.close();
        await second.close();
        await third?.close();
        server.stop(true);
    }
});

test("recording expiry stops service state, releases routing, and notifies the native model", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const destination = join(root, "destination");
    await mkdir(destination);
    const { server, routing } = cdpFixture();
    const deadlines: (() => void)[] = [];
    const original = globalThis.setTimeout;
    const captureTimer = new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
            const [callback, delay, ...parameters] = args;
            if (typeof delay === "number" && delay >= 299000 && delay <= 300000 && typeof callback === "function") {
                deadlines.push(() => callback(...parameters));
            }
            return Reflect.apply(target, receiver, args);
        },
    });
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(captureTimer);
    let ended: (value: unknown) => void = () => {};
    const endedEvent = new Promise<unknown>((resolveEnded) => {
        ended = resolveEnded;
    });
    const service = new ShowOnceService((event) => {
        if (event && typeof event === "object" && "type" in event && event.type === "recording-ended") {
            ended(event);
        }
    });
    try {
        await service.dispatch({
            op: "record-start",
            port: server.port!,
            targetId: "first",
            downloadDirectory: root,
            destinationDirectory: destination,
        });
        expect(deadlines).toHaveLength(2);
        deadlines[0]();
        deadlines[1]();
        const event = await Promise.race([
            endedEvent,
            new Promise<never>((_resolve, reject) => {
                const timer = original(() => reject(new Error("Expiry did not finish")), 1000);
                void endedEvent.finally(() => clearTimeout(timer));
            }),
        ]);
        expect(event).toMatchObject({ type: "recording-ended" });
        expect(await service.dispatch({ op: "status" })).toMatchObject({ recording: false, starting: false });
        expect(routing).toEqual(["allow", "default"]);
        await service.dispatch({
            op: "record-start",
            port: server.port!,
            targetId: "second",
            downloadDirectory: root,
            destinationDirectory: destination,
        });
        await service.dispatch({ op: "record-stop", title: "Normal recording" });
        expect(routing).toEqual(["allow", "default", "allow", "default"]);
    } finally {
        timerSpy.mockRestore();
        await service.close();
        server.stop(true);
    }
});

test("CLI recording duration leaves recorder and service deadline headroom", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const destination = join(root, "destination");
    await mkdir(destination);
    const delays: number[] = [];
    const original = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
        new Proxy(original, {
            apply(fn, receiver, args: unknown[]) {
                if (typeof args[1] === "number" && args[1] >= 299000) {
                    delays.push(args[1]);
                }
                return Reflect.apply(fn, receiver, args);
            },
        })
    );
    const { server } = cdpFixture();
    const service = new ShowOnceService();
    try {
        await service.dispatch({
            op: "record-start",
            port: server.port!,
            targetId: "first",
            downloadDirectory: root,
            destinationDirectory: destination,
            maxSeconds: 360,
        });
        expect(delays).toHaveLength(2);
        expect(delays.every((delay) => delay > 300000)).toBe(true);
        await service.dispatch({ op: "record-stop", title: "Full duration" });
        expect(await service.dispatch({ op: "status" })).toMatchObject({ recording: false, starting: false });
    } finally {
        timer.mockRestore();
        await service.close();
        server.stop(true);
    }
});

test("CLI saves normal stop output but never saves after cancellation during stop", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    for (const cancel of [false, true]) {
        const file = join(root, `${cancel}.showonce.json`);
        const preload = join(root, `${cancel}-preload.ts`);
        await Bun.write(
            preload,
            `import {ShowOnceService} from ${SafeJSON.stringify(join(import.meta.dir, "service.ts"), { strict: true })};
            const originalTimer = globalThis.setTimeout;
            globalThis.setTimeout = new Proxy(originalTimer, {apply(fn, receiver, args) {
                if(args[1] === 300000) args[1] = 0; return Reflect.apply(fn, receiver, args);
            }});
            ShowOnceService.prototype.dispatch = async function(command) {
                if(command.op === 'record-start') {
                    if(command.maxSeconds !== 360) throw Error('Missing CLI deadline headroom');
                    return {recording:true};
                }
                if(command.op === 'record-stop') {
                    if(${cancel}) process.emit('SIGINT');
                    await Promise.resolve();
                    return {recipe:{id:'fixture'}};
                }
                if(command.op === 'save') await Bun.write(command.file,'saved');
                return {};
            };`
        );
        const child = Bun.spawn(
            [
                process.execPath,
                "--preload",
                preload,
                "src/show-once/index.ts",
                "record",
                "--port",
                "1234",
                "--target",
                "first",
                "--downloads",
                root,
                "--destination",
                root,
                "--out",
                file,
                "--seconds",
                "300",
            ],
            { cwd: join(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        const output = new Response(child.stdout).text();
        const errors = new Response(child.stderr).text();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            const exit = await Promise.race([
                child.exited,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error("Mock CLI did not stop")), 2000);
                }),
            ]);
            clearTimeout(deadline);
            expect(await errors).not.toContain("Missing CLI deadline headroom");
            expect(await Bun.file(file).exists()).toBe(!cancel);
            if (cancel) {
                expect(exit).not.toBe(0);
                expect(await output).toBe("");
            } else {
                expect(exit).toBe(0);
                expect(await output).toContain("fixture");
            }
        } finally {
            clearTimeout(deadline);
            child.kill("SIGKILL");
            await child.exited;
            await output;
            await errors;
        }
    }
});

test("CLI Ctrl-C cancels attachment and active recording without saving a recipe", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const destination = join(root, "destination");
    await mkdir(destination);
    for (const phase of ["setup", "recording"] as const) {
        let reached: () => void = () => {};
        const ready = new Promise<void>((resolveReady) => {
            reached = resolveReady;
        });
        const { server } = cdpFixture({
            onCommand: (method) => {
                if (phase === "setup" && method === "Page.enable") {
                    reached();
                    return false;
                }
            },
        });
        const file = join(root, `${phase}.showonce.json`);
        const child = Bun.spawn(
            [
                process.execPath,
                "src/show-once/index.ts",
                "record",
                "--port",
                String(server.port),
                "--target",
                "first",
                "--downloads",
                root,
                "--destination",
                destination,
                "--out",
                file,
                "--seconds",
                "300",
            ],
            { cwd: join(import.meta.dir, "../../.."), env: process.env, stdout: "pipe", stderr: "pipe" }
        );
        const output = new Response(child.stdout).text();
        let errors = "";
        const stderr = (async () => {
            const decoder = new TextDecoder();
            for await (const bytes of child.stderr) {
                errors += decoder.decode(bytes, { stream: true });
                if (phase === "recording" && errors.includes("Recording. Demonstrate")) {
                    reached();
                }
            }
        })();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                ready,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error(`CLI never reached ${phase}: ${errors}`)), 3000);
                }),
            ]);
            clearTimeout(deadline);
            child.kill("SIGINT");
            const exit = await Promise.race([
                child.exited,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error(`CLI did not stop during ${phase}: ${errors}`)), 1000);
                }),
            ]);
            await stderr;
            expect(exit).not.toBe(0);
            expect(await Bun.file(file).exists()).toBe(false);
            expect(await output).toBe("");
        } finally {
            clearTimeout(deadline);
            child.kill("SIGKILL");
            await child.exited;
            await stderr;
            server.stop(true);
        }
    }
});

test("recording preserves unsupported navigation and later page actions as review steps", () => {
    const recipe = recipeFromRecording({
        title: "Unsupported navigation",
        downloads: [],
        snapshot: {
            initialUrl: "https://example.com/",
            evidence: [],
            actions: [
                { id: "blank", kind: "navigate", url: "about:blank", at: 1, excluded: false },
                {
                    id: "input",
                    kind: "fill",
                    sourceUrl: "about:blank",
                    value: "shop",
                    locator: { kind: "testId", value: "customer" },
                    at: 2,
                    excluded: false,
                },
                { id: "return", kind: "navigate", url: "https://example.com/report", at: 3, excluded: false },
            ],
        },
    });
    expect(recipe.steps.map((step) => step.kind)).toEqual(["navigate", "unsupported", "unsupported", "navigate"]);
    expect(recipe.allowedOrigins).toEqual(["https://example.com"]);
    expect(recipe.steps[1].evidence.url).toBe("about:blank");
    expect(recipe.steps[2].evidence.url).toBe("about:blank");
});

test("recording preserves unsupported download evidence without a replayable click", () => {
    for (const url of ["data:text/csv,shop", "blob:null/report", "https://alice:secret@example.com/report.csv"]) {
        const recipe = recipeFromRecording({
            title: "Unsupported download",
            downloads: [{ filename: "report.csv", url, at: 2, sha256: "a".repeat(64) }],
            snapshot: {
                initialUrl: "https://example.com/",
                evidence: [],
                actions: [
                    {
                        id: "download",
                        kind: "click",
                        locator: { kind: "testId", value: "download" },
                        at: 1,
                        excluded: false,
                    },
                ],
            },
        });
        expect(recipe.steps.map((step) => step.kind)).toEqual(["navigate", "unsupported"]);
        expect(recipe.steps[1].evidence.recordedFilename).toBe("report.csv");
        expect(recipe.steps[1].evidence.sha256).toBe("a".repeat(64));
        expect(recipe.allowedOrigins).toEqual(["https://example.com"]);
    }
});

test("recording retains bound CDN and blob origins while originless downloads remain refused", () => {
    for (const url of ["https://cdn.example.com/report.csv", "blob:https://example.com/report-id"]) {
        const recipe = recipeFromRecording({
            title: "Browser report",
            downloads: [{ filename: "report.csv", url, at: 2 }],
            snapshot: {
                initialUrl: "https://example.com/",
                evidence: [],
                actions: [
                    {
                        id: "download",
                        kind: "click",
                        locator: { kind: "testId", value: "download" },
                        excluded: false,
                        at: 1,
                    },
                ],
            },
        });
        expect(recipe.steps[1].kind).toBe("download");
        expect(recipe.allowedOrigins).toContain(downloadOrigin(url));
    }
    for (const url of [
        "data:text/csv,shop",
        "blob:null/report",
        "blob:https://alice:secret@example.com/report-id",
        "file:///tmp/report.csv",
        "https://alice:secret@example.com/report.csv",
    ]) {
        expect(() => downloadOrigin(url)).toThrow();
    }
});

test("replay verifies allowed blob and CDN output, and refuses unapproved download origins", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const file = join(root, "report.csv");
    await Bun.write(file, "shop,2026-10,sales,42");
    const { server } = cdpFixture();
    try {
        for (const url of [
            "blob:https://example.com/report-id",
            "https://cdn.example.com/report.csv",
            "https://unapproved.example.com/report.csv",
        ]) {
            const browser = await connectSession({ port: server.port!, targetId: "first", directory: root });
            spyOn(browser, "action").mockImplementation(async (options) => {
                options.onDispatch();
                return "Download click dispatched";
            });
            spyOn(browser, "waitDownload").mockResolvedValue({
                guid: "download",
                filename: "report.csv",
                url,
                path: file,
                at: 1,
            });
            const recipe = parseRecipe({
                ...sampleRecipe(),
                parameters: [],
                allowedOrigins: ["https://example.com", "https://cdn.example.com"],
                steps: [
                    {
                        id: "download",
                        title: "Download",
                        kind: "download",
                        enabled: true,
                        evidence,
                        pageUrl: "https://example.com/",
                        locator: { kind: "testId", value: "download" },
                        filename: "report.csv",
                        contains: ["shop,2026-10,sales,42"],
                    },
                ],
            });
            const receipt = await runRecipe({
                recipe,
                inputs: {},
                port: server.port!,
                targetId: "first",
                downloadDirectory: root,
                connect: async () => browser,
            });
            if (url.includes("unapproved")) {
                expect(receipt.status).toBe("failed");
                expect(receipt.files).toHaveLength(0);
                expect(receipt.events.at(-1)?.message).toContain("outside allowed origins");
            } else {
                expect(receipt.status).toBe("completed");
                expect(receipt.files[0].path).toBe(file);
                expect(receipt.files[0].sha256).toHaveLength(64);
                expect(receipt.events.at(-1)?.status).toBe("verified");
            }
        }
    } finally {
        server.stop(true);
    }
});

test("file move rechecks cancellation after the destination existence lookup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const source = join(root, "source.csv");
    const target = join(root, "result.csv");
    await Bun.write(source, "shop report");
    const controller = new AbortController();
    let lookups = 0;
    let dispatched = 0;
    const original = fsPromises.lstat;
    const lookup = spyOn(fsPromises, "lstat").mockImplementation(
        new Proxy(original, {
            apply(fn, receiver, args: unknown[]) {
                const result = Reflect.apply(fn, receiver, args);
                if (args[0] === target) {
                    lookups++;
                    controller.abort(new Error("Cancelled during destination check"));
                }
                return result;
            },
        })
    );
    try {
        await expect(
            moveVerified({
                source,
                destination: root,
                filename: "result.csv",
                contains: [],
                signal: controller.signal,
                onDispatch: () => {
                    dispatched++;
                },
            })
        ).rejects.toThrow("Cancelled during destination check");
        expect(lookups).toBe(1);
        expect(dispatched).toBe(0);
        expect(await Bun.file(source).text()).toBe("shop report");
        expect(await Bun.file(target).exists()).toBe(false);
    } finally {
        lookup.mockRestore();
    }
});

test("recording cancellation restores browser routing while page cleanup is still pending", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const destination = join(root, "destination");
    await mkdir(destination);
    let release: () => void = () => {};
    let reached: () => void = () => {};
    let restored: () => void = () => {};
    const cleanupHeld = new Promise<void>((resolveReady) => {
        reached = resolveReady;
    });
    const routingRestored = new Promise<void>((resolveReady) => {
        restored = resolveReady;
    });
    const { server, routing } = cdpFixture({
        onCommand: (method, resume) => {
            if (method === "Page.removeScriptToEvaluateOnNewDocument") {
                release = resume;
                reached();
                return false;
            }
            if (method === "Browser.setDownloadBehavior" && routing.length > 0) {
                restored();
            }
        },
    });
    const service = new ShowOnceService();
    let cancelled: Promise<unknown> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        await service.dispatch({
            op: "record-start",
            port: server.port!,
            targetId: "first",
            downloadDirectory: root,
            destinationDirectory: destination,
        });
        cancelled = service.dispatch({ op: "cancel" });
        await Promise.race([
            cleanupHeld,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(() => reject(new Error("Recorder cleanup never started")), 1000);
            }),
        ]);
        clearTimeout(deadline);
        await Promise.race([
            routingRestored,
            new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(() => reject(new Error("Browser routing waits behind recorder cleanup")), 200);
            }),
        ]);
        expect(routing).toEqual(["allow", "default"]);
        release();
        await cancelled;
        expect(await service.dispatch({ op: "status" })).toMatchObject({ recording: false });
    } finally {
        clearTimeout(deadline);
        release();
        await cancelled;
        await service.close();
        server.stop(true);
    }
});

test("rejecting cleanup waits for its delayed peer and preserves cancellation or setup errors", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gt-show-once-test-")));
    const destination = join(root, "destination");
    await mkdir(destination);
    for (const cause of ["cancel", "setup"] as const) {
        for (const rejecting of ["recorder", "browser"] as const) {
            const { server } = cdpFixture();
            const cleanupError = new Error(`${rejecting} cleanup rejected`);
            const setupError = new Error("Recording setup failed");
            let release: () => void = () => {};
            const delayed = new Promise<void>((resolveDelay) => {
                release = resolveDelay;
            });
            let entered: () => void = () => {};
            const bothEntered = new Promise<void>((resolveEntered) => {
                entered = resolveEntered;
            });
            let stopCalls = 0;
            let closeCalls = 0;
            let browserClosed = false;
            const cleanupWork: Promise<unknown>[] = [];
            const countStarted = () => {
                if (stopCalls && closeCalls) {
                    entered();
                }
            };
            const snapshot: recording.ActionRecordingSnapshot = {
                initialUrl: "https://example.com/",
                actions: [],
                evidence: [],
            };
            const recorder = spyOn(recording, "startActionRecording").mockResolvedValue({
                snapshot: () => snapshot,
                stop: () => {
                    const work = (async () => {
                        stopCalls++;
                        countStarted();
                        if (rejecting === "recorder") {
                            throw cleanupError;
                        }
                        await delayed;
                        return snapshot;
                    })();
                    cleanupWork.push(work);
                    return work;
                },
            });
            const originalConnect = browserModule.connectSession;
            let actualBrowser: browserModule.BrowserSession | undefined;
            let originalClose: (() => Promise<void>) | undefined;
            const connect = spyOn(browserModule, "connectSession").mockImplementation(async (options) => {
                const browser = await originalConnect(options);
                actualBrowser = browser;
                originalClose = browser.close.bind(browser);
                browser.close = () => {
                    const work = (async () => {
                        closeCalls++;
                        countStarted();
                        if (rejecting === "browser") {
                            throw cleanupError;
                        }
                        await delayed;
                        await originalClose?.();
                        browserClosed = true;
                    })();
                    cleanupWork.push(work);
                    return work;
                };
                if (cause === "setup") {
                    const configure = browser.configureDownloads.bind(browser);
                    browser.configureDownloads = async (settings) => {
                        await configure(settings);
                        throw setupError;
                    };
                }
                return browser;
            });
            const service = new ShowOnceService();
            const command = {
                op: "record-start",
                port: server.port!,
                targetId: "first",
                downloadDirectory: root,
                destinationDirectory: destination,
            };
            let outcome: Promise<{ error: unknown } | { result: unknown }> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                const started = service.dispatch(command);
                if (cause === "cancel") {
                    await started;
                    outcome = service.dispatch({ op: "cancel" }).then(
                        (result) => ({ result }),
                        (error) => ({ error })
                    );
                } else {
                    outcome = started.then(
                        (result) => ({ result }),
                        (error) => ({ error })
                    );
                }
                await Promise.race([
                    bothEntered,
                    new Promise<never>((_resolve, reject) => {
                        deadline = setTimeout(() => reject(new Error("Both cleanup operations did not start")), 1000);
                    }),
                ]);
                clearTimeout(deadline);
                await Promise.race([
                    outcome.then(() => {
                        throw new Error("Cleanup returned before its delayed peer settled");
                    }),
                    new Promise<void>((resolveObserve) => {
                        deadline = setTimeout(resolveObserve, 100);
                    }),
                ]);
                clearTimeout(deadline);
                expect(await service.dispatch({ op: "status" })).toMatchObject({ recording: false, starting: true });
                await expect(service.dispatch(command)).rejects.toThrow("Stop the active operation");
                release();
                const observed = await outcome;
                expect("error" in observed ? observed.error : undefined).toBe(
                    cause === "setup" ? setupError : cleanupError
                );
                expect(stopCalls).toBe(1);
                expect(closeCalls).toBe(1);
                expect(await service.dispatch({ op: "status" })).toMatchObject({ recording: false, starting: false });
            } finally {
                clearTimeout(deadline);
                release();
                await outcome;
                await Promise.allSettled(cleanupWork);
                recorder.mockRestore();
                connect.mockRestore();
                if (actualBrowser && originalClose) {
                    actualBrowser.close = originalClose;
                    if (!browserClosed) {
                        await originalClose();
                    }
                }
                await service.close();
                server.stop(true);
            }
        }
    }
});
