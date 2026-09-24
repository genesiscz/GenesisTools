#!/usr/bin/env bun
/**
 * Differential test: the OLD guard (GenesisClaude, still live on this machine) against the
 * NEW one, over every Bash command in the local transcript corpus. Any divergence in the
 * resolved outcome or in the rule set is a port bug.
 *
 * Read-only. It reads transcripts and spawns one child that imports the old library; it
 * touches no repository, and the commands it hands the child live in a private temp directory
 * that is removed when the run ends.
 *
 * Usage: bun scripts/hooks-parity.ts [limit=500]
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluateCommand } from "@app/agents/lib/hooks/guard";
import { importedHooksConfig, readLegacyGuardConfig } from "@app/agents/lib/hooks/import-config";
import { withPrivateTempDir } from "@app/agents/lib/hooks/private-temp";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const OLD_LIB = join(homedir(), ".claude", "hooks", "lib", "bashGuard.ts");
const PROJECTS = join(homedir(), ".claude", "projects");
/** A transcript larger than this is skipped: reading it costs more than the commands buy. */
const MAX_TRANSCRIPT_BYTES = 40_000_000;

interface ToolUseBlock {
    type?: string;
    name?: string;
    input?: { command?: unknown };
}

function commandsFromTranscripts(limit: number): string[] {
    const found: string[] = [];
    const seen = new Set<string>();

    const walk = (dir: string): void => {
        if (found.length >= limit) {
            return;
        }

        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (found.length >= limit) {
                return;
            }

            const path = join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(path);
                continue;
            }

            if (!entry.name.endsWith(".jsonl") || statSync(path).size > MAX_TRANSCRIPT_BYTES) {
                continue;
            }

            for (const line of readFileSync(path, "utf8").split("\n")) {
                if (found.length >= limit || !line.includes('"Bash"')) {
                    continue;
                }

                let record: { message?: { content?: ToolUseBlock[] } } | null = null;

                try {
                    record = SafeJSON.parse(line, { strict: true }) as { message?: { content?: ToolUseBlock[] } };
                } catch {
                    // A truncated transcript line contributes no command.
                    continue;
                }

                for (const block of record?.message?.content ?? []) {
                    const command = block.input?.command;

                    if (block.type === "tool_use" && block.name === "Bash" && typeof command === "string") {
                        if (!seen.has(command)) {
                            seen.add(command);
                            found.push(command);
                        }
                    }
                }
            }
        }
    };

    walk(PROJECTS);

    return found;
}

interface Verdict {
    outcome: string;
    tags: string[];
}

/**
 * One child process for the whole corpus. The old guard's CLI reads a single payload from
 * stdin, so 3000 commands would be 3000 bun starts; importing its library once is the same
 * code path (`evaluateCommand`) at a fraction of the wall time.
 */
function oldVerdicts(commands: string[]): Verdict[] {
    // The commands come from real transcripts, inline secrets included, so they cross to the child
    // through a private directory that is removed afterwards, never the shared temp folder.
    return withPrivateTempDir("hooks-parity-", (dir) => {
        const input = dir.write("input.json", SafeJSON.stringify(commands));
        const runner = dir.write(
            "runner.ts",
            [
                `import { readFileSync } from "node:fs";`,
                `import { evaluateCommand, loadGuardConfig } from ${SafeJSON.stringify(OLD_LIB)};`,
                `const commands = JSON.parse(readFileSync(${SafeJSON.stringify(input)}, "utf8"));`,
                `const config = loadGuardConfig();`,
                `const out = commands.map((command) => {`,
                `    const verdict = evaluateCommand(command, { config, model: null, harness: "claude", contextCounts: {} });`,
                `    return { outcome: verdict.outcome, tags: verdict.tags };`,
                `});`,
                `process.stdout.write(JSON.stringify(out));`,
            ].join("\n")
        );

        const run = spawnSync("bun", [runner], { encoding: "utf8", maxBuffer: 256_000_000 });

        if (run.status !== 0) {
            throw new Error(`The old guard runner failed: ${run.stderr?.slice(0, 2000)}`);
        }

        return SafeJSON.parse(run.stdout, { strict: true }) as Verdict[];
    });
}

const limit = Number.parseInt(process.argv[2] ?? "500", 10);
const commands = commandsFromTranscripts(limit);
const old = oldVerdicts(commands);
// The old side runs under the machine's tuned legacy config (`loadGuardConfig()`), so the new side
// runs under the SAME overrides, imported the way `config import` does it. Evaluating against the
// shipped defaults reported every legacy override as a port bug.
const imported = importedHooksConfig(readLegacyGuardConfig());
const mismatches: { command: string; old: Verdict; fresh: Verdict }[] = [];

for (const [index, command] of commands.entries()) {
    const verdict = evaluateCommand(command, imported, {
        model: null,
        harness: "claude",
        contextCounts: {},
    });
    const fresh: Verdict = { outcome: verdict.outcome, tags: verdict.tags };
    const before = old[index];

    if (!before) {
        continue;
    }

    if (before.outcome !== fresh.outcome || before.tags.join(",") !== fresh.tags.join(",")) {
        mismatches.push({ command: command.split("\n")[0]?.slice(0, 90) ?? "", old: before, fresh });
    }
}

out.println(`compared ${commands.length} unique commands`);
out.println(`mismatches: ${mismatches.length}`);

for (const row of mismatches.slice(0, 20)) {
    out.println(
        `  old=${row.old.outcome.padEnd(7)}[${row.old.tags.join(",")}] new=${row.fresh.outcome.padEnd(7)}[${row.fresh.tags.join(",")}] ${row.command}`
    );
}

process.exit(mismatches.length === 0 ? 0 : 1);
