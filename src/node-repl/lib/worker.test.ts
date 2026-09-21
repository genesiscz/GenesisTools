import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const WORKER_PATH = join(import.meta.dir, "worker.ts");

/** A GENESIS_TOOLS_HOME whose node-repl/trust.json holds the given policy. */
function homeWithPolicy(policy: Record<string, unknown>): string {
    const home = mkdtempSync(join(tmpdir(), "node-repl-home-"));
    mkdirSync(join(home, ".genesis-tools", "node-repl"), { recursive: true });
    writeFileSync(join(home, ".genesis-tools", "node-repl", "trust.json"), SafeJSON.stringify(policy));
    return home;
}

/**
 * Feeds every line to ONE worker and collects its replies. One spawn rather than one per case
 * on purpose: each spawn is a full bun start plus a native oxc-parser load, and the CI suite
 * runs on a 4-vCPU runner against a wall-clock budget.
 */
async function ask(
    lines: string[],
    extraEnv: Record<string, string> = {}
): Promise<{ replies: Record<string, unknown>[]; exitCode: number | null }> {
    // env: the worker mkdtemps an image directory under TMPDIR, which bun test sets on
    // process.env only — a child spawned without it would write into the real temp folder.
    const worker = Bun.spawn([process.execPath, WORKER_PATH], {
        env: { ...process.env, ...extraEnv },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdin = worker.stdin as { write(data: string): void; flush(): void; end(): void };

    for (const line of lines) {
        stdin.write(`${line}\n`);
    }

    stdin.flush();
    stdin.end();
    const stdout = await new Response(worker.stdout).text();
    await worker.exited;

    return {
        replies: stdout
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => SafeJSON.parse(line, { strict: true }) as Record<string, unknown>),
        exitCode: worker.exitCode,
    };
}

describe("node-repl worker protocol", () => {
    // A worker that dies on a bad line leaves the parent's promise unsettled, so the caller
    // waits out the entire wall clock for what is a parse error. Both malformed shapes and the
    // requests that follow them go through one worker, which is also the proof that a bad line
    // does not end the session.
    it("answers every malformed line and keeps serving the requests after them", async () => {
        const { replies, exitCode } = await ask([
            "this is not json",
            SafeJSON.stringify({ id: 7, op: "run", code: "1 + 1" }),
            SafeJSON.stringify({ id: 3, op: "nonsense" }),
            SafeJSON.stringify({ id: 4, op: "run", code: "'still here'" }),
        ]);

        expect(replies).toHaveLength(4);

        expect(replies[0]).toMatchObject({ ok: false });
        expect(String(replies[0].error)).toContain("not JSON");

        expect(replies[1]).toMatchObject({ id: 7, ok: true, text: "2" });

        // A JSON line that is not a request keeps its id, so the parent settles that exact
        // promise instead of waiting for a response that is never coming.
        expect(replies[2]).toMatchObject({ id: 3, ok: false });
        expect(String(replies[2].error)).toContain("unsupported request");

        expect(replies[3]).toMatchObject({ id: 4, ok: true });
        expect(exitCode).toBe(0);
    }, 30_000);
});

// 🛑 The negative control for the import gate, driven through the REAL path: the policy file on
// disk, the worker's own loadImportPolicy, and the vm's importModuleDynamically hook. Asserting
// importAllowed() directly proves the decision function, not the wiring — a gate that returns
// "deny" into a hook nobody consults would pass a unit test and refuse nothing.
describe("node-repl import gate, end to end", () => {
    it("refuses a builtin under allowBuiltins:false, in BOTH spellings", async () => {
        const home = homeWithPolicy({ allowBuiltins: false, allowRepoDeps: true, allowPaths: true });
        const { replies } = await ask(
            [
                SafeJSON.stringify({ id: 1, op: "run", code: "await import('node:fs')" }),
                // The bare spelling is the same module to Bun, and was the hole.
                SafeJSON.stringify({ id: 2, op: "run", code: "await import('fs')" }),
                // A builtin SUBPATH is the same class and must not slip past either.
                SafeJSON.stringify({ id: 3, op: "run", code: "await import('fs/promises')" }),
            ],
            { GENESIS_TOOLS_HOME: home }
        );

        expect(replies).toHaveLength(3);
        for (const reply of replies) {
            expect(reply.ok).toBe(false);
            expect(String(reply.error)).toContain("is not allowed by");
        }
    }, 30_000);

    // The other half: the guard must not have broken ordinary use.
    it("still allows those same imports under the default policy", async () => {
        const home = homeWithPolicy({ allowBuiltins: true });
        const { replies } = await ask(
            [
                SafeJSON.stringify({
                    id: 1,
                    op: "run",
                    code: "const m = await import('fs/promises'); typeof m.readFile",
                }),
            ],
            { GENESIS_TOOLS_HOME: home }
        );

        expect(replies[0]).toMatchObject({ id: 1, ok: true });
        expect(String(replies[0].text)).toContain("function");
    }, 30_000);
});

/**
 * 🛑 stdout carries the line protocol. A console.log that reaches it is not a cosmetic leak: the
 * parent cannot parse the line, drops it with a warning, and the turn still reports ok, so the
 * output vanishes while the call looks successful. `ask` parses EVERY stdout line strictly, so a
 * leak fails these cases loudly rather than quietly.
 */
describe("node-repl console capture", () => {
    it("puts console output in the turn text and never on the protocol channel", async () => {
        const { replies, exitCode } = await ask([
            SafeJSON.stringify({ id: 1, op: "run", code: "console.log('from console'); 'the result'" }),
        ]);

        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ id: 1, ok: true });
        expect(String(replies[0].text)).toBe("from console\nthe result");
        expect(exitCode).toBe(0);
    }, 30_000);

    it("joins several arguments and inspects the ones that are not strings", async () => {
        const { replies } = await ask([
            SafeJSON.stringify({ id: 1, op: "run", code: "console.warn('n =', { a: 1 }); undefined" }),
        ]);

        expect(replies[0]).toMatchObject({ id: 1, ok: true });
        expect(String(replies[0].text)).toContain("n =");
        expect(String(replies[0].text)).toContain("a: 1");
    }, 30_000);

    // The other half: capturing console must not disturb the two channels that already worked.
    it("leaves nodeRepl.write and the last expression exactly as they were", async () => {
        const { replies } = await ask([
            SafeJSON.stringify({ id: 1, op: "run", code: "nodeRepl.write('written'); 2 + 3" }),
        ]);

        expect(String(replies[0].text)).toBe("written\n5");
    }, 30_000);

    // The buffer is per turn. A leak here would attribute one turn's output to the next.
    it("clears the captured output between turns", async () => {
        const { replies } = await ask([
            SafeJSON.stringify({ id: 1, op: "run", code: "console.log('first turn'); 1" }),
            SafeJSON.stringify({ id: 2, op: "run", code: "2" }),
        ]);

        expect(String(replies[0].text)).toBe("first turn\n1");
        expect(String(replies[1].text)).toBe("2");
    }, 30_000);
});
