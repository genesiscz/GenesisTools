import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, postOrder } from "./graph";
import { measureGraph } from "./measure";

let root: string;

function write(rel: string, source: string): string {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
    return file;
}

/**
 * One worker spawn per mode covers everything: a normal module, one that calls process.exit()
 * while importing (a CLI parsing argv), one that throws, and the entry that imports them all.
 * The hang case gets its own two spawns because it has to be killed, and the timeout is kept
 * short so the file stays cheap; the kill is a timer, never a poll.
 */
beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gt-ts-measure-test-")));
    mkdirSync(join(root, ".git"));
    write("leaf.ts", "export const leaf = 1;");
    write("mid.ts", 'import { leaf } from "./leaf";\nexport const mid = leaf + 1;');
    write("exits.ts", "export const before = 1;\nprocess.exit(3);");
    write("throws.ts", 'throw new Error("boom at import");');
    write(
        "entry.ts",
        [
            'import { mid } from "./mid";',
            'let exits = 0; try { exits = (await import("./exits")).before; } catch { exits = -1; }',
            'let threw = 0; try { await import("./throws"); } catch { threw = 1; }',
            "export const total = mid + exits + threw;",
        ].join("\n")
    );
    write("hang.ts", "await new Promise(() => {});\nexport const never = 1;");
    write("hang-entry.ts", 'import { leaf } from "./leaf";\nimport "./hang";\nexport const v = leaf;');
});

describe("measureGraph", () => {
    it("times every importable module children-first and the entry cold", async () => {
        const entry = join(root, "entry.ts");
        const graph = buildGraph({ entry, root, includeDynamic: true });
        const order = postOrder(graph, entry);
        const result = await measureGraph({ graph, order, runs: 1, timeoutMs: 20_000, cwd: root });

        expect(result.timedOut).toBe(false);
        expect(result.self.get(join(root, "leaf.ts"))?.status).toBe("ok");
        expect(result.self.get(join(root, "mid.ts"))?.status).toBe("ok");
        expect(result.self.get(join(root, "exits.ts"))).toMatchObject({ status: "exit", message: "3" });
        expect(result.self.get(join(root, "throws.ts"))?.status).toBe("error");
        expect(result.self.get(join(root, "throws.ts"))?.message).toContain("boom at import");
        expect(result.self.get(entry)?.status).toBe("ok");
        expect(result.cold?.status).toBe("ok");

        for (const sample of result.self.values()) {
            expect(sample.ms).toBeGreaterThanOrEqual(0);
        }
        // The exiting module did not take the worker down: the entry, imported after it, has a sample.
        expect(result.self.size).toBe(5);
    });

    it("kills a worker whose module never resolves and keeps the samples before it", async () => {
        const entry = join(root, "hang-entry.ts");
        const graph = buildGraph({ entry, root });
        const order = postOrder(graph, entry);
        const result = await measureGraph({ graph, order, runs: 1, timeoutMs: 400, cwd: root });

        expect(result.timedOut).toBe(true);
        expect(result.self.get(join(root, "leaf.ts"))?.status).toBe("ok");
        expect(result.self.has(join(root, "hang.ts"))).toBe(false);
        expect(result.self.has(entry)).toBe(false);
    });

    it("gives one unsettling module its own deadline instead of killing the run", async () => {
        const entry = join(root, "hang-entry.ts");
        const graph = buildGraph({ entry, root });
        const order = postOrder(graph, entry);
        const result = await measureGraph({
            graph,
            order,
            runs: 1,
            timeoutMs: 20_000,
            moduleTimeoutMs: 300,
            cwd: root,
        });

        // The worker finished on its own: no kill, and every plan line has a sample.
        expect(result.timedOut).toBe(false);
        expect(result.self.get(join(root, "leaf.ts"))?.status).toBe("ok");
        expect(result.self.get(join(root, "hang.ts"))?.status).toBe("hang");
        // The entry statically imports the module that never settled. Whether bun lets that
        // import resolve anyway is bun's business and not what this test is for; what matters is
        // that the run continued and the entry still produced a sample, where before the whole
        // worker was killed and everything from `hang.ts` onwards was missing.
        expect(result.self.has(entry)).toBe(true);
    });

    it("gives an entrypoint the --help argv, so a default action that prompts cannot hang it", async () => {
        // What `tools ai` does: commander runs its DEFAULT action for an empty argv, and that
        // action opens a clack select which waits on a stdin that is /dev/null in the worker.
        // Both workers used to be killed at --timeout on that one module.
        write(
            "argv-entry.ts",
            [
                'if (process.argv[2] !== "--help") {',
                "    await new Promise(() => {});",
                "}",
                "",
                "process.exit(7);",
            ].join("\n")
        );
        const entry = join(root, "argv-entry.ts");
        const graph = buildGraph({ entry, root });
        const order = postOrder(graph, entry);
        const result = await measureGraph({
            graph,
            order,
            runs: 1,
            timeoutMs: 20_000,
            moduleTimeoutMs: 2_000,
            cwd: root,
        });

        expect(result.timedOut).toBe(false);
        expect(result.self.get(entry)).toMatchObject({ status: "exit", message: "7" });
        expect(result.cold).toMatchObject({ status: "exit", message: "7" });
    });
});
