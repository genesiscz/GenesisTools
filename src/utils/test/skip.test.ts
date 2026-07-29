import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
