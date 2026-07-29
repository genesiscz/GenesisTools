import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { optIn } from "@genesiscz/utils/test/skip";

// Was opt-OUT via AGENTS_E2E, which meant one 89s bash matrix ran in every
// ordinary suite and blew the parallel run's timeout. It now uses the shared
// harness like every other heavy suite: `bun run test:e2e`, or RUN_AGENTS_E2E=1.
const ENABLED = optIn.agentsE2E || optIn.e2e;
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
