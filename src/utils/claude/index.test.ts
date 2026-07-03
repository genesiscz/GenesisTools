import { afterEach, describe, expect, test } from "bun:test";
import { _setFindClaudeCommandTestHooks, findClaudeCommand } from "./index";

describe("findClaudeCommand timeout cleanup", () => {
    afterEach(() => {
        _setFindClaudeCommandTestHooks(undefined);
    });

    test("kills the candidate-probe child when the timeout race loses", async () => {
        const marker = `sleep-30-claude-test-${Date.now()}`;

        _setFindClaudeCommandTestHooks({
            candidates: ["hung-probe"],
            timeoutMs: 100,
            spawnProbe: () =>
                Bun.spawn({
                    cmd: ["sh", "-c", `exec -a ${marker} sleep 30`],
                    stdio: ["ignore", "pipe", "pipe"],
                }),
        });

        await findClaudeCommand();
        await new Promise((r) => setTimeout(r, 200));

        const after = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
        expect(after).toBe("");
    });
});
