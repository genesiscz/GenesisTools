#!/usr/bin/env bun
/**
 * Reads the shadow decision log and reports what the NEW hooks decided on real traffic,
 * then re-runs the OLD guard over the same commands and counts divergences.
 *
 * Read-only: it reads the log and spawns one child that imports the old library.
 *
 * Usage: bun scripts/hooks-shadow-report.ts [--since <ISO or 1d/2h/30m>]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadHooksConfig } from "@app/agents/lib/hooks/config";
import { withPrivateTempDir } from "@app/agents/lib/hooks/private-temp";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

const OLD_LIB = join(homedir(), ".claude", "hooks", "lib", "bashGuard.ts");

interface Record_ {
    at?: string;
    phase?: string;
    decision?: string;
    reason?: string;
    harness?: string;
    session?: string;
    command?: string;
    roots?: string[];
    captured?: number;
    files?: string[];
}

function sinceMs(value: string | undefined): number {
    if (!value) {
        return 0;
    }

    const relative = /^(\d+)([dhm])$/.exec(value);

    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2];
        const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;

        return Date.now() - amount * ms;
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? 0 : parsed;
}

const sinceIndex = process.argv.indexOf("--since");
const floor = sinceMs(sinceIndex >= 0 ? process.argv[sinceIndex + 1] : undefined);
const config = loadHooksConfig();
let logText = "";

try {
    logText = readFileSync(config.logPath, "utf8");
} catch (err) {
    out.println(`no decision log at ${config.logPath}: ${String(err)}`);
    process.exit(1);
}

// Concurrent hook processes can leave a torn line. One bad line used to throw out of the whole
// read and report "no decision log", which named the wrong cause; `hooks log` skips it, so do we.
const records: Record_[] = [];
let tornLines = 0;

for (const line of logText.split("\n")) {
    if (line.length === 0) {
        continue;
    }

    try {
        records.push(SafeJSON.parse(line, { strict: true }) as Record_);
    } catch {
        tornLines += 1;
    }
}

if (tornLines > 0) {
    out.println(`skipped ${tornLines} unparseable line(s) in ${config.logPath}`);
}

const inWindow = records.filter((record) => (record.at ? Date.parse(record.at) >= floor : floor === 0));
const byPhase = new Map<string, Map<string, number>>();
const sessions = new Set<string>();
const harnesses = new Set<string>();

for (const record of inWindow) {
    const phase = record.phase ?? "?";
    const counts = byPhase.get(phase) ?? new Map<string, number>();

    counts.set(record.decision ?? "?", (counts.get(record.decision ?? "?") ?? 0) + 1);
    byPhase.set(phase, counts);

    if (record.session) {
        sessions.add(record.session);
    }

    if (record.harness) {
        harnesses.add(record.harness);
    }
}

out.println(`records in window: ${inWindow.length}`);
out.println(`sessions: ${sessions.size}   harnesses: ${[...harnesses].join(", ") || "none"}`);

for (const [phase, counts] of [...byPhase].sort()) {
    const detail = [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([decision, count]) => `${decision}=${count}`)
        .join("  ");

    out.println(`  ${phase.padEnd(6)} ${detail}`);
}

const guarded = inWindow.filter((record) => record.phase === "guard" && typeof record.command === "string");

if (guarded.length === 0) {
    out.println("divergences: 0 (no guard record carried its command; nothing to re-run)");
    process.exit(0);
}

/**
 * Replays the logged commands through the OLD guard, in a child that imports its library.
 *
 * The input holds commands verbatim, inline secrets included (see `logCommands`), so it goes into
 * a private `mkdtemp` directory (mode 0700) as 0600 files and is removed when the replay ends.
 * It used to sit in the shared temp folder at the umask's mode and was never deleted.
 *
 * Each record is replayed under ITS harness: a codex or grok record replayed as claude met
 * claude's overrides and showed a divergence that was not one.
 */
function replayOld(records: Record_[]): string[] {
    return withPrivateTempDir("hooks-shadow-", (dir) => {
        const input = dir.write(
            "input.json",
            SafeJSON.stringify(
                records.map((record) => ({ command: record.command, harness: record.harness ?? "claude" }))
            )
        );
        const runner = dir.write(
            "runner.ts",
            [
                `import { readFileSync } from "node:fs";`,
                `import { evaluateCommand, loadGuardConfig } from ${SafeJSON.stringify(OLD_LIB)};`,
                `const entries = JSON.parse(readFileSync(${SafeJSON.stringify(input)}, "utf8"));`,
                `const config = loadGuardConfig();`,
                `process.stdout.write(JSON.stringify(entries.map((entry) => evaluateCommand(entry.command, { config, model: null, harness: entry.harness, contextCounts: {} }).outcome)));`,
            ].join("\n")
        );

        const run = spawnSync("bun", [runner], { encoding: "utf8", maxBuffer: 256_000_000 });

        if (run.status !== 0) {
            throw new Error(
                `the old guard runner failed (exit ${run.status ?? run.signal}): ${run.stderr || run.error || "no stderr"}`
            );
        }

        return SafeJSON.parse(run.stdout, { strict: true }) as string[];
    });
}

let oldOutcomes: string[];

try {
    oldOutcomes = replayOld(guarded);
} catch (err) {
    out.println(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
let divergences = 0;

guarded.forEach((record, index) => {
    if (oldOutcomes[index] !== record.decision) {
        divergences += 1;
        out.println(`  old=${oldOutcomes[index]} new=${record.decision} ${String(record.command).slice(0, 80)}`);
    }
});

out.println(`replayed: ${guarded.length}`);
out.println(`divergences: ${divergences}`);
process.exit(divergences === 0 ? 0 : 1);
