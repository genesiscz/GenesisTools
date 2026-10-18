import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { describeGates, GATE_ENV_VARS, optIn } from "./skip";

describe("test gate harness", () => {
    test("every opt-in gate has an env variable and vice versa", () => {
        expect(Object.keys(GATE_ENV_VARS).sort()).toEqual(Object.keys(optIn).sort());
    });

    test("describeGates partitions every gate exactly once", () => {
        const { enabled, disabled } = describeGates();

        expect([...enabled, ...disabled].sort()).toEqual(Object.keys(optIn).sort());
        expect(enabled.filter((gate) => disabled.includes(gate))).toEqual([]);
    });

    /**
     * scripts/test.ts duplicates this table on purpose: it runs before
     * `bun install` repairs the tree, and inside a worktree the @genesiscz alias
     * resolves to the main checkout. The duplication is safe only while the two
     * lists agree, which is what this test enforces.
     */
    test("the runner's copy of the gate table is in step with this one", () => {
        const runner = readFileSync(join(import.meta.dir, "../../../scripts/test.ts"), "utf8");
        const block = runner.match(/const GATE_ENV_VARS: Record<string, string> = \{([\s\S]*?)\};/);

        expect(block).not.toBeNull();

        const runnerGates = [...(block?.[1] ?? "").matchAll(/^\s*(\w+):\s*"([A-Z0-9_]+)"/gm)].map(
            ([, gate, variable]) => [gate, variable]
        );

        expect(Object.fromEntries(runnerGates)).toEqual(GATE_ENV_VARS);
    });
});

test("a gate reads its variable with the same rule as env.test, so a padded 0 is off in both", () => {
    const probe = `import { optIn } from ${SafeJSON.stringify(join(import.meta.dir, "skip.ts"))};
import { env } from "@genesiscz/utils/env";
console.log([optIn.e2e, env.test.shouldRunE2E(), optIn.integration, env.test.shouldRunIntegration()].join(","));`;
    const run = (value: string) =>
        Bun.spawnSync([process.execPath, "-e", probe], {
            cwd: join(import.meta.dir, "../../.."),
            env: { ...process.env, RUN_E2E: value, RUN_INTEGRATION: value },
            stdout: "pipe",
            stderr: "pipe",
        })
            .stdout.toString()
            .trim();

    expect(run(" 0")).toBe("false,false,false,false");
    expect(run(" 1 ")).toBe("true,true,true,true");
});
