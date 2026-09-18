import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { JsonLineProcess } from "@genesiscz/utils/process/json-line-process";
import { ReplEngine, resultMessage } from "./engine";

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
        engine.reset();
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
