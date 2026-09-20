#!/usr/bin/env bun
/**
 * For every rule x harness x representative command length, resolve the outcome under the
 * OLD guard config file and under the config the importer produces from it. Any difference
 * is a migration bug: a threshold or an override was dropped.
 *
 * Read-only: it reads the legacy config and spawns one child that imports the old library.
 *
 * Usage: bun scripts/hooks-config-parity.ts [--from <legacy config path>]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOOKS_CONFIG } from "@app/agents/lib/hooks/config";
import { evaluateCommand } from "@app/agents/lib/hooks/guard";
import { guardFromLegacy, legacyGuardConfigPath, readLegacyGuardConfig } from "@app/agents/lib/hooks/import-config";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";

const OLD_LIB = join(homedir(), ".claude", "hooks", "lib", "bashGuard.ts");
const HARNESSES = ["claude", "codex", "grok", "unknown"] as const;
const LENGTHS = [
    { label: "short", lines: 1, chars: 40 },
    { label: "at the line threshold", lines: 30, chars: 400 },
    { label: "at the char threshold", lines: 5, chars: 2500 },
    { label: "long", lines: 80, chars: 9000 },
];

/**
 * A command of a given shape that ALSO trips the named rule, so the resolution being
 * compared is the rule's, not "no rule matched" four times over.
 */
function commandFor(rule: { wrong: string }, length: { lines: number; chars: number }): string {
    const filler: string[] = [];
    const perLine = Math.max(1, Math.ceil(length.chars / Math.max(1, length.lines)));

    for (let index = 0; index < Math.max(0, length.lines - 1); index++) {
        filler.push(`echo ${"x".repeat(Math.max(1, perLine - 6))}`);
    }

    const body = [...filler, rule.wrong].join("\n");

    return body.length >= length.chars ? body : `${body}\n# ${"y".repeat(length.chars - body.length)}`;
}

const fromIndex = process.argv.indexOf("--from");
const from = fromIndex >= 0 ? (process.argv[fromIndex + 1] as string) : legacyGuardConfigPath();
const legacy = readLegacyGuardConfig(from);
const imported = { ...DEFAULT_HOOKS_CONFIG, guard: guardFromLegacy(legacy) };

interface Case {
    ruleId: string;
    harness: string;
    length: string;
    command: string;
}

const cases: Case[] = [];

for (const rule of SHELL_RULES) {
    for (const harness of HARNESSES) {
        for (const length of LENGTHS) {
            cases.push({ ruleId: rule.id, harness, length: length.label, command: commandFor(rule, length) });
        }
    }
}

const input = join(tmpdir(), `hooks-config-parity-${process.pid}.json`);
const runner = join(tmpdir(), `hooks-config-parity-old-${process.pid}.ts`);

writeFileSync(input, SafeJSON.stringify({ cases, legacyPath: from }));
writeFileSync(
    runner,
    [
        `import { readFileSync } from "node:fs";`,
        `import { evaluateCommand, loadGuardConfig } from ${SafeJSON.stringify(OLD_LIB)};`,
        `const { cases, legacyPath } = JSON.parse(readFileSync(${SafeJSON.stringify(input)}, "utf8"));`,
        `const config = loadGuardConfig(legacyPath);`,
        `process.stdout.write(JSON.stringify(cases.map((one) => {`,
        `    const verdict = evaluateCommand(one.command, { config, model: null, harness: one.harness, contextCounts: {} });`,
        `    return { outcome: verdict.outcome, tags: verdict.tags.join(",") };`,
        `})));`,
    ].join("\n")
);

const run = spawnSync("bun", [runner], { encoding: "utf8", maxBuffer: 256_000_000 });

if (run.status !== 0) {
    throw new Error(`The old guard runner failed: ${run.stderr?.slice(0, 2000)}`);
}

const oldResults = SafeJSON.parse(run.stdout, { strict: true }) as { outcome: string; tags: string }[];
const mismatches: string[] = [];

cases.forEach((one, index) => {
    const verdict = evaluateCommand(one.command, imported, {
        model: null,
        harness: one.harness as "claude" | "codex" | "grok",
        contextCounts: {},
    });
    const before = oldResults[index];

    if (!before) {
        return;
    }

    if (before.outcome !== verdict.outcome || before.tags !== verdict.tags.join(",")) {
        mismatches.push(
            `${one.ruleId} x ${one.harness} x ${one.length}: old=${before.outcome}[${before.tags}] new=${verdict.outcome}[${verdict.tags.join(",")}]`
        );
    }
});

out.println(`legacy config: ${from}`);
out.println(`${cases.length} resolutions, mismatches: ${mismatches.length}`);

for (const row of mismatches.slice(0, 30)) {
    out.println(`  ${row}`);
}

process.exit(mismatches.length === 0 ? 0 : 1);
