import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const MODULE = join(import.meta.dir, "foreground.ts");

/**
 * The launcher's case in a real pseudo-terminal (`script`): an interactive zsh child runs `exec <shell function>`, as
 * `tools claude run` does with `ccc`, and the function forks a command with job control, so zsh's group holds the
 * terminal when it exits (a plain `f` without `exec` gives it back). Then a terminal call of the parent
 * fails (here EIO, because the group of a child of `script` is orphaned; in a shell tab it is a SIGTTOU stop).
 */
async function runInPty(reclaim: boolean, childGroup?: number): Promise<{ state: unknown; raw: string }> {
    const dir = mkdtempSync(join(tmpdir(), "foreground-"));
    const outFile = join(dir, "result.json");
    const code = [
        `import { reclaimTerminalForeground, terminalForegroundOwner } from ${SafeJSON.stringify(MODULE)};`,
        `import { writeFileSync } from "node:fs";`,
        "const initial = terminalForegroundOwner(0);",
        `const child = Bun.spawn({ cmd: ["/bin/zsh", "-fic", "f() { /bin/sh -c 'exit 0'; }; exec f"], stdio: ["inherit", "inherit", "inherit"] });`,
        "await child.exited;",
        `const state = ${reclaim} ? reclaimTerminalForeground(0, { initial, childGroup: ${childGroup ?? "child.pid"} }) : null;`,
        `let raw = "ok";`,
        "try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch (error) { raw = String(error); }",
        `writeFileSync(${SafeJSON.stringify(outFile)}, JSON.stringify({ state, raw }));`,
        "process.exit(0);",
    ].join("\n");
    const proc = await boundedCommand({
        command: ["script", "-q", "/dev/null", "bun", "-e", code],
        timeoutMs: 5_000,
        environment: { ...process.env, GENESIS_TOOLS_HOME: dir },
    });
    if (proc.status !== 0) {
        throw new Error(`PTY fixture failed: ${proc.stderr}`);
    }

    return SafeJSON.parse(readFileSync(outFile, "utf8"), { strict: true }) as { state: unknown; raw: string };
}

describe.skipIf(process.platform !== "darwin")("the terminal after a job-control child ends", () => {
    test("NEGATIVE CONTROL: without the reclaim, the parent cannot switch the terminal to raw mode", async () => {
        const result = await runInPty(false);

        expect(result.raw).not.toBe("ok");
    });

    test("a launch cannot reclaim a foreground group it did not create", async () => {
        const result = await runInPty(true, -1);
        expect(result.state).toMatchObject({ status: "unavailable" });
        expect(result.raw).not.toBe("ok");
    });

    test("the reclaim gives the terminal back, and raw mode works again", async () => {
        const result = await runInPty(true);

        expect(result.state).toMatchObject({ status: "reclaimed" });
        expect(result.raw).toBe("ok");
    });
});
