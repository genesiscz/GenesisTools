import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import { Command } from "commander";
import pc from "picocolors";
import {
    BLOCK_END,
    BLOCK_START,
    extractHotPaths,
    type HotPath,
    parseHistory,
    suggestAlias,
    updateMyelination,
    upsertManagedBlock,
} from "./core";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = "state.json";

interface PathState {
    commands: string[];
    level: number;
    lastSeen: string;
    count: number;
}

interface MyelinState {
    paths: Record<string, PathState>;
}

interface ScanParams {
    minN: number;
    maxN: number;
    threshold: number;
    top: number;
}

interface ReportPath {
    key: string;
    commands: string[];
    count: number;
    score: number;
    level: number;
    alias: { name: string; command: string };
}

interface AnalyzeReport {
    history: string;
    scannedAt: string;
    params: ScanParams;
    counts: { lines: number; hot: number };
    paths: ReportPath[];
}

const storage = new Storage("aliases");

function statePath(): string {
    return join(storage.getCacheDir(), STATE_FILE);
}

function emptyState(): MyelinState {
    return { paths: {} };
}

async function readState(): Promise<MyelinState> {
    const file = statePath();
    if (!existsSync(file)) {
        return emptyState();
    }

    try {
        const text = await Bun.file(file).text();
        const parsed = SafeJSON.parse(text) as MyelinState;
        return parsed.paths ? parsed : emptyState();
    } catch (error) {
        logger.warn({ error, file }, "aliases: failed to read state, starting fresh");
        return emptyState();
    }
}

/**
 * Resolve the history file: --history wins, then $HISTFILE, then
 * ~/.zsh_history, then ~/.bash_history. Returns null if none exists.
 */
function resolveHistoryFile(explicit?: string): string | null {
    if (explicit) {
        return existsSync(explicit) ? explicit : null;
    }

    const candidates: string[] = [];
    const envHist = process.env.HISTFILE;
    if (envHist) {
        candidates.push(envHist);
    }

    candidates.push(join(homedir(), ".zsh_history"));
    candidates.push(join(homedir(), ".bash_history"));

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function daysSince(lastSeen: string, now: number): number {
    const then = Date.parse(lastSeen);
    if (Number.isNaN(then)) {
        return 0;
    }

    return Math.max(0, (now - then) / DAY_MS);
}

function escapeForSingleQuote(s: string): string {
    return s.replace(/'/g, "'\\''");
}

/**
 * Mine history, extract hot paths, and update myelination state (unless
 * `noState`). Returns the report plus the raw command count.
 */
async function runAnalysis(opts: {
    historyFile: string;
    params: ScanParams;
    noState: boolean;
    now: number;
}): Promise<AnalyzeReport> {
    const raw = await Bun.file(opts.historyFile).text();
    const commands = parseHistory(raw);
    logger.debug({ historyFile: opts.historyFile, commands: commands.length }, "aliases: parsed history");

    const hot = extractHotPaths({
        commands,
        minN: opts.params.minN,
        maxN: opts.params.maxN,
        threshold: opts.params.threshold,
        top: opts.params.top,
    });

    const nowIso = new Date(opts.now).toISOString();
    const taken = new Set<string>();

    let reportPaths: ReportPath[];

    if (opts.noState) {
        reportPaths = hot.map((path: HotPath) => {
            const key = path.commands.join(" ");
            const level = updateMyelination({ level: 0, reused: true, daysSince: 0 });
            const alias = suggestAlias(path.commands, taken);

            return {
                key,
                commands: path.commands,
                count: path.count,
                score: path.score,
                level: Math.round(level * 100) / 100,
                alias,
            };
        });
    } else {
        const nextState = await storage.atomicUpdate<MyelinState>(STATE_FILE, (current) => {
            const next: MyelinState = current?.paths ? current : emptyState();
            for (const path of hot) {
                const key = path.commands.join(" ");
                const priorPath = next.paths[key];
                const level = updateMyelination({
                    level: priorPath?.level ?? 0,
                    reused: true,
                    daysSince: priorPath ? daysSince(priorPath.lastSeen, opts.now) : 0,
                });
                next.paths[key] = {
                    commands: path.commands,
                    level: Math.round(level * 100) / 100,
                    lastSeen: nowIso,
                    count: path.count,
                };
            }

            return next;
        });

        reportPaths = hot.map((path: HotPath) => {
            const key = path.commands.join(" ");
            const alias = suggestAlias(path.commands, taken);

            return {
                key,
                commands: path.commands,
                count: path.count,
                score: path.score,
                level: nextState.paths[key].level,
                alias,
            };
        });
    }

    reportPaths.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }

        return b.level - a.level;
    });

    return {
        history: opts.historyFile,
        scannedAt: nowIso,
        params: opts.params,
        counts: { lines: commands.length, hot: hot.length },
        paths: reportPaths,
    };
}

function bar(level: number, max = 10): string {
    const filled = Math.round((Math.min(level, max) / max) * 10);
    return "█".repeat(filled) + "░".repeat(Math.max(0, 10 - filled));
}

function renderHuman(report: AnalyzeReport, minLevel: number): string {
    const lines: string[] = [];
    lines.push(
        `aliases — ${report.history} (n=${report.params.minN}..${report.params.maxN}, threshold ${report.params.threshold})`
    );
    lines.push("");
    lines.push(`mined ${report.counts.lines} lines · ${report.counts.hot} hot paths`);
    lines.push("");

    if (report.paths.length === 0) {
        lines.push("No hot command sequences found above the threshold.");
        return lines.join("\n");
    }

    lines.push("HOT AXONS (ranked by activity score)");
    for (const path of report.paths) {
        const chain = path.commands.join("  →  ");
        lines.push(
            `  ${bar(path.level)}  ${chain}  ×${path.count}  level ${path.level.toFixed(1)}  alias: ${path.alias.name}`
        );
    }

    const suggested = report.paths.filter((p) => p.level >= minLevel);
    if (suggested.length > 0) {
        lines.push("");
        lines.push(`SUGGESTED ALIASES (level >= ${minLevel})`);
        for (const path of suggested) {
            lines.push(`  alias ${path.alias.name}='${escapeForSingleQuote(path.alias.command)}'`);
        }

        lines.push("");
        lines.push(`Run \`tools aliases apply\` to write ${suggested.length} aliases to your rc (managed block).`);
    }

    return lines.join("\n");
}

interface AnalyzeFlags {
    history?: string;
    minN?: string;
    maxN?: string;
    threshold?: string;
    top?: string;
    state?: boolean;
    json?: boolean;
}

function parseParams(flags: AnalyzeFlags): ScanParams {
    return {
        minN: flags.minN ? Number.parseInt(flags.minN, 10) : 2,
        maxN: flags.maxN ? Number.parseInt(flags.maxN, 10) : 4,
        threshold: flags.threshold ? Number.parseInt(flags.threshold, 10) : 3,
        top: flags.top ? Number.parseInt(flags.top, 10) : 20,
    };
}

async function analyzeAction(flags: AnalyzeFlags): Promise<void> {
    const historyFile = resolveHistoryFile(flags.history);
    if (!historyFile) {
        out.error("No history file found. Pass --history <file> (tried $HISTFILE, ~/.zsh_history, ~/.bash_history).");
        process.exitCode = 1;
        return;
    }

    const report = await runAnalysis({
        historyFile,
        params: parseParams(flags),
        noState: flags.state === false,
        now: Date.now(),
    });

    if (flags.json) {
        out.result(SafeJSON.stringify(report, null, 2));
        return;
    }

    out.result(renderHuman(report, 2));
}

interface ApplyFlags extends AnalyzeFlags {
    rc?: string;
    minLevel?: string;
    print?: boolean;
}

async function applyAction(flags: ApplyFlags): Promise<void> {
    const historyFile = resolveHistoryFile(flags.history);
    if (!historyFile) {
        out.error("No history file found. Pass --history <file>.");
        process.exitCode = 1;
        return;
    }

    const minLevel = flags.minLevel ? Number.parseFloat(flags.minLevel) : 2;
    const report = await runAnalysis({
        historyFile,
        params: parseParams(flags),
        noState: flags.state === false,
        now: Date.now(),
    });

    const chosen = report.paths.filter((p) => p.level >= minLevel);
    const blockBody = chosen.map((p) => `alias ${p.alias.name}='${escapeForSingleQuote(p.alias.command)}'`).join("\n");

    if (flags.print) {
        const block =
            blockBody.length > 0 ? `${BLOCK_START}\n${blockBody}\n${BLOCK_END}` : `${BLOCK_START}\n${BLOCK_END}`;
        out.print(`${block}\n`);
        return;
    }

    const rcFile = flags.rc ?? defaultRcFile();
    const current = existsSync(rcFile) ? await Bun.file(rcFile).text() : "";
    const updated = upsertManagedBlock(current, blockBody);
    await Bun.write(rcFile, updated);
    logger.debug({ rcFile, aliases: chosen.length }, "aliases: wrote managed block");
    out.log.success(`Wrote ${chosen.length} alias(es) to the managed block in ${rcFile}`);
}

function defaultRcFile(): string {
    const zshrc = join(homedir(), ".zshrc");
    if (existsSync(zshrc)) {
        return zshrc;
    }

    const bashrc = join(homedir(), ".bashrc");
    if (existsSync(bashrc)) {
        return bashrc;
    }

    return zshrc;
}

interface DecayFlags {
    json?: boolean;
}

async function decayAction(flags: DecayFlags): Promise<void> {
    const now = Date.now();
    let decayed = 0;
    let pruned = 0;

    const next = await storage.atomicUpdate<MyelinState>(STATE_FILE, (current) => {
        const state: MyelinState = current?.paths ? current : emptyState();
        const result = emptyState();

        for (const [key, path] of Object.entries(state.paths)) {
            const level = updateMyelination({
                level: path.level,
                reused: false,
                daysSince: daysSince(path.lastSeen, now),
            });
            decayed += 1;

            if (level <= 0) {
                pruned += 1;
                continue;
            }

            result.paths[key] = {
                ...path,
                level: Math.round(level * 100) / 100,
            };
        }

        return result;
    });

    if (flags.json) {
        out.result(SafeJSON.stringify({ decayed, pruned, paths: next.paths }, null, 2));
        return;
    }

    out.result(`Decay pass complete: ${decayed} path(s) aged, ${pruned} pruned (level 0).`);
}

async function statusAction(): Promise<void> {
    const state = await readState();
    const entries = Object.values(state.paths).sort((a, b) => b.level - a.level);

    if (entries.length === 0) {
        out.result("No myelination state yet. Run `tools aliases analyze` first.");
        return;
    }

    const lines: string[] = [`aliases state — ${entries.length} path(s)`, ""];
    for (const entry of entries) {
        lines.push(
            `  ${bar(entry.level)}  level ${entry.level.toFixed(1)}  ×${entry.count}  ${entry.commands.join("  →  ")}`
        );
    }

    out.result(lines.join("\n"));
}

async function resetAction(): Promise<void> {
    await storage.atomicUpdate<MyelinState>(STATE_FILE, () => emptyState());
    out.log.success("Cleared myelination state.");
}

const program = new Command();

program
    .name("aliases")
    .description(
        "Use-dependent command-path compiler: mines shell history for hot command chains (activity-dependent myelination) and proposes compiled aliases."
    );

function addScanFlags(cmd: Command): Command {
    return cmd
        .option("--history <file>", "Path to a history file (default: auto-detect zsh/bash)")
        .option("--min-n <n>", "Minimum n-gram length", "2")
        .option("--max-n <n>", "Maximum n-gram length", "4")
        .option("-t, --threshold <n>", "Minimum occurrences to be hot", "3")
        .option("--top <n>", "Show at most N hot paths", "20")
        .option("--no-state", "Pure scan: do not read/update myelination state")
        .option("--json", "Emit the full report as JSON to stdout");
}

addScanFlags(
    program
        .command("analyze", { isDefault: true })
        .description("Mine history, show hot sequences + suggested aliases, scored")
).action(analyzeAction);

addScanFlags(program.command("apply").description("Write suggested aliases into the managed rc block (or print)"))
    .option("--rc <file>", "Target rc file (default: auto-detect ~/.zshrc or ~/.bashrc)")
    .option("--min-level <n>", "Only emit paths whose myelination level >= n", "2")
    .option("--print", "Print the alias block to stdout instead of writing the rc")
    .action(applyAction);

program
    .command("decay")
    .description("Age out unused paths: apply per-day decay, drop dead paths")
    .option("--json", "Emit the post-decay state as JSON")
    .action(decayAction);

program.command("status").description("Show the persisted myelination state, no scan").action(statusAction);

program.command("reset").description("Clear the persisted myelination state").action(resetAction);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "aliases" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out.error(pc.red(message));
        process.exit(1);
    }
}

main();
