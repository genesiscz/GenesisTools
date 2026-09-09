import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalRestoreCommand } from "@app/cmux/lib/restore";

/**
 * These run the generated line through the real `/bin/zsh`, because the defect was a shell
 * semantics one: joining every part with `&&` meant a `cd` into a saved directory that no
 * longer exists swallowed the readiness marker. `waitForTerminalText` then burned its 30 s
 * and threw, and the throw aborts `populatePane`'s loop, so every LATER tab of that pane was
 * never renamed and never replayed.
 */

const MARKER = "printf '\\n%s%s\\n' 'cmux-ready-' 'abc123'";

async function runInZsh(command: string): Promise<{ stdout: string; stderr: string }> {
    const child = Bun.spawn(["/bin/zsh", "-c", command], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;

    return { stdout, stderr };
}

test("a saved directory that is gone still prints the readiness marker", async () => {
    const missing = join(tmpdir(), "cmux-restore-no-such-dir-r07");
    const { stdout, stderr } = await runInZsh(internalRestoreCommand([`cd -- '${missing}'`], [MARKER]));

    expect(stdout).toContain("cmux-ready-abc123");
    // The failure is not hidden either: the pane shows why it is in the wrong directory.
    expect(stderr).toContain("no such file or directory");
});

test("a saved directory that exists is entered, and the marker still prints", async () => {
    const present = mkdtempSync(join(tmpdir(), "cmux-restore-present-"));
    const { stdout } = await runInZsh(internalRestoreCommand([`cd -- '${present}'`, "pwd"], [MARKER]));

    expect(stdout).toContain(present);
    expect(stdout).toContain("cmux-ready-abc123");
});

test("the setup steps still chain, so a failed step skips the ones after it", async () => {
    // The `&&` between the parts is the point: the saved screen must not be `cat`ed when the
    // clear before it failed. Only the trailing marker is exempt.
    const { stdout } = await runInZsh(internalRestoreCommand(["false", "printf 'MUST-NOT-RUN\\n'"], [MARKER]));

    expect(stdout).not.toContain("MUST-NOT-RUN");
    expect(stdout).toContain("cmux-ready-abc123");
});

test("with no trailing statement the command is exactly the chain", async () => {
    const { stdout } = await runInZsh(internalRestoreCommand(["printf 'one\\n'", "printf 'two\\n'"]));

    expect(stdout.split("\n").filter(Boolean)).toEqual(["one", "two"]);
});
