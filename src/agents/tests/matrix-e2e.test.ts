import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { env } from "@app/utils/env";

// Default-on, opt-out via explicit "0" — route through the env facade (dynamic-key
// lookup, same helper used for ask ProviderConfig.envKey) so env.testing
// overrides stay the single mechanism for controlling env-gated behavior.
const ENABLED = env.ai.getByEnvKey("AGENTS_E2E") !== "0";
const SCRIPT = join(import.meta.dir, "matrix.sh");

describe.if(ENABLED)("agents matrix e2e", () => {
    test("all CLI permutations pass", async () => {
        const proc = Bun.spawn(["bash", SCRIPT], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, AGENTS_E2E_RUN: "1" },
        });

        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        if (exitCode !== 0) {
            const tail = stdout.split("\n").slice(-60).join("\n");
            console.error(`=== matrix.sh stdout (last 60 lines) ===\n${tail}`);

            if (stderr.trim()) {
                console.error(`=== matrix.sh stderr ===\n${stderr}`);
            }
        }

        expect(exitCode).toBe(0);
    }, 180_000);
});
