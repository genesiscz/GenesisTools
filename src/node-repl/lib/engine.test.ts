import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectLabel } from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { JsonLineProcess } from "@genesiscz/utils/process/json-line-process";
import { describeMethod, searchMethods } from "@genesiscz/utils/repl/discovery";
import { jsDescription } from "../mcp/server";
import { ReplEngine, resultMessage } from "./engine";
import { createToolsets, parseToolsetList, REPL_TOOLSET_IDS, toolsetCliHelp } from "./toolsets";

it("CLI help renders registered descriptor methods and handles", () => {
    const help = toolsetCliHelp();
    expect(help).toContain("recorder.start(options?:");
    expect(help).toContain("recording.stop(");
    expect(help).toContain("editor.open(source: string)");
});

// The MCP server renders a js_add_node_module_dir result with this. A timeout or a worker exit
// reports through `error` with an EMPTY `text`, so reading `text` alone answered those failures
// with a blank string — an isError response carrying no reason at all.
describe("resultMessage", () => {
    it("returns the output on success", () => {
        expect(resultMessage({ ok: true, text: "module directory registered", error: undefined })).toBe(
            "module directory registered"
        );
    });

    it("returns the reason on the failures that leave text empty", () => {
        expect(resultMessage({ ok: false, text: "", error: "worker exited before answering" })).toBe(
            "worker exited before answering"
        );
        expect(resultMessage({ ok: false, text: "", error: "boom", stack: "boom\n  at x" })).toBe("boom\n  at x");
    });

    it("never answers a failure with an empty string", () => {
        expect(resultMessage({ ok: false, text: "", error: undefined })).toBe("unknown error");
        expect(resultMessage({ ok: false, text: "", error: "" })).toBe("unknown error");
    });
});

describe("ReplEngine", () => {
    const engine = new ReplEngine({ defaultTimeoutMs: 10_000 });

    afterAll(() => {
        engine.dispose();
    });

    it("keeps bindings across turns, redeclares them, and awaits at the top level", async () => {
        const first = await engine.run("let z = await Promise.resolve(41);\nz + 1");
        expect(first.ok).toBe(true);
        expect(first.text).toBe("42");

        const second = await engine.run("const z = await Promise.resolve(100);\nz");
        expect(second.text).toBe("100");

        const third = await engine.run(
            "class Foo { m() { return 2; } }\nfunction twice(n) { return n * 2; }\ntwice(new Foo().m())"
        );
        expect(third.text).toBe("4");

        const fourth = await engine.run("[typeof Foo, typeof twice, z]");
        expect(fourth.text).toContain('"function"');
        expect(fourth.text).toContain("100");
    });

    it("accepts TypeScript, collects nodeRepl.write, and returns the last expression", async () => {
        const result = await engine.run("const n: number = 3;\nnodeRepl.write('a');\nnodeRepl.write({ b: 1 });\nn * n");
        expect(result.ok).toBe(true);
        expect(result.text).toBe("a\n{\n  b: 1,\n}\n9");
    });

    it("reports a thrown error with the output produced before it", async () => {
        const result = await engine.run("nodeRepl.write('before');\nthrow new Error('boom')");
        expect(result.ok).toBe(false);
        expect(result.error).toBe("boom");
        expect(result.text).toBe("before");
    });

    it("emits images as base64 plus a file on disk", async () => {
        const result = await engine.run(
            "await nodeRepl.emitImage({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' });\n'done'"
        );
        expect(result.ok).toBe(true);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mimeType).toBe("image/png");
        expect(result.images[0].data).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
        expect(result.images[0].path).toContain("node-repl-images-");
    });

    it("kills a turn that overruns, on the wall clock, and starts clean", async () => {
        await engine.run("globalThis.marker = 'alive'");
        const stuck = await engine.run("while (true) { await Promise.resolve(); }", 400);
        expect(stuck.ok).toBe(false);
        expect(stuck.error).toContain("exceeded 400 ms");
        const after = await engine.run("typeof marker");
        expect(after.ok).toBe(true);
        expect(after.text).toBe("undefined");
    });

    it("carries a declaration without an initialiser into the next turn", async () => {
        const declared = await engine.run("let pending;\ntypeof pending");
        expect(declared.ok).toBe(true);
        expect(declared.text).toBe("undefined");

        const assigned = await engine.run("pending = 5;\npending + 1");
        expect(assigned.ok).toBe(true);
        expect(assigned.text).toBe("6");
    });

    it("reset drops every binding", async () => {
        await engine.run("let keep = 1");
        await engine.reset();
        const result = await engine.run("typeof keep");
        expect(result.text).toBe("undefined");
    });

    it("imports builtins, and a bare package from a registered directory", async () => {
        const builtin = await engine.run("const p = await import('node:path');\np.basename('/a/b.txt')");
        expect(builtin.text).toBe("b.txt");

        const dir = mkdtempSync(join(tmpdir(), "node-repl-pkg-"));
        mkdirSync(join(dir, "node_modules", "fakepkg"), { recursive: true });
        writeFileSync(
            join(dir, "node_modules", "fakepkg", "package.json"),
            SafeJSON.stringify({ name: "fakepkg", main: "index.js" })
        );
        writeFileSync(join(dir, "node_modules", "fakepkg", "index.js"), "module.exports = { answer: 7 };");
        const registered = await engine.addModuleDir(dir);
        expect(registered.ok).toBe(true);
        const imported = await engine.run("const m = await import('fakepkg');\nm.default?.answer ?? m.answer");
        expect(imported.ok).toBe(true);
        expect(imported.text).toBe("7");
    });
});

it("JSON-line transport reuses its worker and cancels without replay", async () => {
    const transport = new JsonLineProcess({
        command: [
            process.execPath,
            "-e",
            "let count=0; for await (const chunk of Bun.stdin.stream()) { count++; console.log('{\"count\":'+count+'}'); }",
        ],
    });
    try {
        expect(await transport.request({ input: { request: "first" } })).toEqual({ count: 1 });
        expect(await transport.request({ input: { request: "second" } })).toEqual({ count: 2 });
        const controller = new AbortController();
        const cancelled = transport.request({ input: { request: "cancel" }, signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toThrow("cancelled");
        await expect(transport.request({ input: { request: "must not replay" } })).rejects.toThrow("closed");
    } finally {
        transport.close();
    }
});

describe("bounded command ownership", () => {
    it("collects complete UTF-8 output without blocking the parent event loop", async () => {
        let timerRan = false;
        const timer = setTimeout(() => {
            timerRan = true;
        }, 1);
        const result = await boundedCommand({
            command: [process.execPath, "-e", 'process.stdout.write("hello 🐈"); process.stderr.write("diagnostic");'],
            timeoutMs: 5000,
        });
        clearTimeout(timer);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("hello 🐈");
        expect(result.stderr).toBe("diagnostic");
        expect(timerRan).toBe(true);
    });
    it("bounds output and cancels a running owned group without retry", async () => {
        const overflow = await boundedCommand({
            command: [process.execPath, "-e", 'process.stdout.write("x".repeat(2048));'],
            timeoutMs: 5000,
            maxBufferBytes: 1024,
        });
        expect(overflow.error?.code).toBe("ENOBUFS");
        expect(overflow.stdout.length).toBeLessThanOrEqual(1024);
        const cancelled = await boundedCommand({
            command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            timeoutMs: 5000,
            signal: AbortSignal.timeout(100),
        });
        expect(cancelled.error?.code).toBe("ABORT_ERR");
        await expect(
            boundedCommand({ command: ["/never-spawn"], timeoutMs: 100, signal: AbortSignal.abort() })
        ).rejects.toThrow();
    });
});

const FIXTURE = join(import.meta.dir, "__fixtures__", "counter-toolset.ts");
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
);

describe("toolsets", () => {
    // NR1 and NR7 (deep test 2026-11-06): an agent calls a read method without asking, so a read method reaches no
    // one, and every method that prompts the user, takes the screen or spends money says so in its declaration.
    it("every toolset declares who its calls reach, and no read method reaches anyone", async () => {
        const reaching: Record<string, string> = {};

        for (const toolset of await createToolsets(REPL_TOOLSET_IDS)) {
            const owners = [
                { owner: toolset.api.global, methods: toolset.api.methods },
                ...(toolset.api.handles ?? []).map((handle) => ({
                    owner: `${toolset.api.global}.${handle.name}`,
                    methods: handle.methods,
                })),
            ];

            for (const { owner, methods } of owners) {
                for (const method of methods) {
                    if (method.effect === "read") {
                        expect(method.reaches ?? []).toEqual([]);
                    }

                    if (method.reaches?.length) {
                        reaching[`${owner}.${method.name}`] = effectLabel(method);
                    }
                }
            }
        }

        expect(reaching).toEqual({
            "recorder.start": "reversible · user",
            "movies.record": "reversible · user",
            "movies.demo": "reversible · user",
            "movies.Movie.transcript": "reversible · paid · user",
            "movies.Movie.copy": "destructive · user",
            "movies.Movie.reveal": "reversible · user",
            "movies.Movie.show": "reversible · user",
            "movies.Movie.closeEditor": "reversible · user",
            "meetings.assign.sweep": "reversible · user",
            "meetings.Meeting.assign.ask": "reversible · user",
        });
    });

    it("describe accepts handle names from both help and search", async () => {
        const engine = new ReplEngine({ toolsets: ["recorder"] });
        try {
            expect((await engine.run('help("recorder")')).text).toContain("recording.displays.mode");
            expect((await engine.run('search("display")')).text).toContain("recorder.Recording.displays.mode");
            const qualified = await engine.run('describe("recorder.Recording.displays.mode")');
            const shorthand = await engine.run('describe("recording.displays.mode")');
            expect(qualified.ok).toBe(true);
            expect(shorthand.ok).toBe(true);
            expect(shorthand.text).toBe(qualified.text);
        } finally {
            await engine.shutdown();
        }
    });

    it("the shared loader validates toolset arguments before invoking their implementation", async () => {
        const engine = new ReplEngine({ toolsets: ["editor"] });
        try {
            const result = await engine.run("editor.open({ recording: 'x' })");
            expect(result.ok).toBe(false);
            expect(result.error).toContain("editor.open(source: string)");
            expect(result.error).not.toContain('The "path" property');
        } finally {
            await engine.shutdown();
        }
    });

    it("preload once per spawn outside the turn timeout, again after a respawn, and dispose on reset", async () => {
        const log = join(mkdtempSync(join(tmpdir(), "node-repl-toolset-")), "dispose.log");
        // The fixture's bootstrap sleeps 200 ms; a 100 ms turn budget still passes because preload has its own.
        const engine = new ReplEngine({ toolsets: [`${FIXTURE}#CounterToolset`], defaultTimeoutMs: 100 });
        try {
            const first = await engine.run("counter.pid");
            expect(first.ok).toBe(true);
            await engine.run(`counter.logTo(${SafeJSON.stringify(log)})`);
            const scratch = (await engine.run("counter.scratch")).text.replace(/'/g, "");
            expect(existsSync(scratch)).toBe(true);
            expect((await engine.run("globalThis.counterBootstraps")).text).toBe("1");
            expect((await engine.run("globalThis.counterBootstraps")).text).toBe("1");

            await engine.reset();
            expect(readFileSync(log, "utf8")).toBe("disposed\n");
            expect(existsSync(scratch)).toBe(false);
            const after = await engine.run("[counter.pid, globalThis.counterBootstraps]");
            expect(after.ok).toBe(true);
            expect(after.text).not.toContain(first.text);
            expect(after.text).toContain("1 ]");

            const overrun = await engine.run("while (true) {}", 50);
            expect(overrun.ok).toBe(false);
            const respawned = await engine.run("globalThis.counterBootstraps");
            expect(respawned.text).toBe("1");
        } finally {
            await engine.shutdown();
        }
    }, 20_000);

    // NR2 (deep test 2026-11-06): one broken toolset used to fail every turn, `1 + 1` and the other toolsets too.
    it("a toolset whose preload throws leaves plain turns and the other toolsets working, and its global names it", async () => {
        const engine = new ReplEngine({ toolsets: ["presets", `${FIXTURE}#BrokenToolset`] });
        try {
            const first = await engine.run("1 + 1");
            expect(first.ok).toBe(true);
            expect(first.text).toBe(
                "the counter toolset did not load: the native backend is missing; its global throws until js_reset\n2"
            );
            expect((await engine.run("typeof presets.list")).text).toBe("function");

            const used = await engine.run('counter.logTo("/tmp/never")');
            expect(used.ok).toBe(false);
            expect(used.error).toBe(
                "the counter toolset did not load: the native backend is missing; js_reset loads it again"
            );
            expect((await engine.run("help()")).text).toContain("counter: did not load: the native backend is missing");

            // A reset preloads again, and the first turn after it says so again.
            await engine.reset();
            expect((await engine.run("3")).text).toStartWith("the counter toolset did not load");
        } finally {
            await engine.shutdown();
        }
    });

    it("help() lists the loaded toolsets from their descriptors and show() returns an image", async () => {
        const engine = new ReplEngine({ toolsets: [`${FIXTURE}#CounterToolset`] });
        try {
            const list = await engine.run("help()");
            expect(list.text).toContain("counter: Counts the preloads of this worker.");
            expect((await engine.run('search("path")')).text).toContain("counter.logTo");
            expect((await engine.run('describe("counter.logTo")')).text).toContain("Parameters:");
            const docs = await engine.run('help("counter")');
            expect(docs.text).toContain("- counter.logTo(path: string) → unknown [reversible]");
            expect((await engine.run('help("nope")')).error).toContain('No toolset "nope" is loaded');

            const shown = await engine.run(
                `await show(Buffer.from(${SafeJSON.stringify(PNG_1X1.toString("base64"))}, "base64")); "ok"`
            );
            expect(shown.ok).toBe(true);
            expect(shown.images.map((image) => image.mimeType)).toEqual(["image/png"]);
            expect(existsSync(shown.images[0].path)).toBe(true);
            const path = shown.images[0].path;
            const byPath = await engine.run(
                `await show(${SafeJSON.stringify(path)}); await show({ path: ${SafeJSON.stringify(path)} })`
            );
            expect(byPath.images).toHaveLength(2);
            expect((await engine.run('await show(Buffer.from("not an image"))')).error).toContain("not a PNG");
        } finally {
            await engine.shutdown();
        }
    });

    it("an engine without toolsets still has help and show", async () => {
        const engine = new ReplEngine();
        try {
            expect((await engine.run("help()")).text).toContain("No toolsets are loaded");
        } finally {
            engine.dispose();
        }
    });

    it("the registry refuses an unknown toolset and names the known ones", () => {
        expect(() => parseToolsetList("computer,nope")).toThrow("Unknown toolset nope; known: computer");
        expect(parseToolsetList(" computer , computer ")).toEqual(["computer"]);
    });

    it("the js description lists each preloaded toolset's one line", () => {
        expect(jsDescription([])).not.toContain("Preloaded globals");
        expect(jsDescription(["counter: Counts. counter.logTo(path)"])).toContain(
            'Preloaded globals, built once per worker (search(query) to find methods; describe(name) for full method docs; help(name) for a toolset; a method marked [read] changes nothing and reaches no one, "· user" or "· paid" marks one that reaches the user or costs money):\n- counter: Counts. counter.logTo(path)'
        );
    });
});

it("reset interrupts an active turn and cancels turns queued before it", async () => {
    const engine = new ReplEngine();
    await engine.run("1");
    const running = engine.run("await new Promise(() => {})", 60000);
    const queued = engine.run("globalThis.shouldNotRun = true");
    let reset: Promise<void> | undefined;

    try {
        reset = engine.reset();
        await Promise.race([
            reset,
            Bun.sleep(500).then(() => {
                throw new Error("reset waited for the active turn");
            }),
        ]);
        expect((await running).ok).toBe(false);
        expect((await queued).ok).toBe(false);
        expect((await engine.run("typeof globalThis.shouldNotRun")).text).toContain("undefined");
    } finally {
        engine.dispose();
        await reset;
        engine.dispose();
    }
});

it("discovery covers handle names, missing names and ambiguous names", async () => {
    const apis = (await createToolsets(["meetings", "browser", "control"])).map((toolset) => toolset.api);
    expect(searchMethods(apis, "items.add")).toContain("meetings.Meeting.items.add");
    expect(describeMethod(apis, "meetings.Meeting.items.add")).toContain("Parameters:");
    expect(() => describeMethod(apis, "missing.method")).toThrow("Unknown method");
    expect(() => describeMethod(apis, "open")).toThrow("Ambiguous method");
    expect(searchMethods(apis, "no-such-method-xyz")).toBe("No matching methods in the loaded toolsets.");
    const notes = apis.find((api) => api.global === "control")!.notes!.join(" ");
    expect(notes).toContain("control.read_image");
    expect(notes).not.toContain("computer.read_image");
});
