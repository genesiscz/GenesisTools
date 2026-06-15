import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    BLOCK_END,
    BLOCK_START,
    extractHotPaths,
    type HotPath,
    parseHistory,
    suggestAlias,
    updateMyelination,
} from "@app/aliases/lib/core";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";

const DAY_MS = 24 * 60 * 60 * 1000;
export const STATE_FILE = "state.json";

export interface PathState {
    commands: string[];
    level: number;
    lastSeen: string;
    count: number;
}

export interface MyelinState {
    paths: Record<string, PathState>;
}

export interface ScanParams {
    minN: number;
    maxN: number;
    threshold: number;
    top: number;
}

export interface ReportPath {
    key: string;
    commands: string[];
    count: number;
    score: number;
    level: number;
    alias: { name: string; command: string };
}

export interface AnalyzeReport {
    history: string;
    scannedAt: string;
    params: ScanParams;
    counts: { lines: number; hot: number };
    paths: ReportPath[];
}

export interface AnalyzeFlags {
    history?: string;
    minN?: string;
    maxN?: string;
    threshold?: string;
    top?: string;
    state?: boolean;
    json?: boolean;
}

export interface ApplyFlags extends AnalyzeFlags {
    rc?: string;
    minLevel?: string;
    print?: boolean;
}

export interface DecayFlags {
    json?: boolean;
}

export const storage = new Storage("aliases");

function statePath(): string {
    return join(storage.getCacheDir(), STATE_FILE);
}

export function emptyState(): MyelinState {
    return { paths: {} };
}

export async function readState(): Promise<MyelinState> {
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
export function resolveHistoryFile(explicit?: string): string | null {
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

export function daysSince(lastSeen: string, now: number): number {
    const then = Date.parse(lastSeen);
    if (Number.isNaN(then)) {
        return 0;
    }

    return Math.max(0, (now - then) / DAY_MS);
}

export function escapeForSingleQuote(s: string): string {
    return s.replace(/'/g, "'\\''");
}

/**
 * Mine history, extract hot paths, and update myelination state (unless
 * `noState`). Returns the report plus the raw command count.
 */
export async function runAnalysis(opts: {
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

export function bar(level: number, max = 10): string {
    const filled = Math.round((Math.min(level, max) / max) * 10);
    return "█".repeat(filled) + "░".repeat(Math.max(0, 10 - filled));
}

export function renderHuman(report: AnalyzeReport, minLevel: number): string {
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

export function parseParams(flags: AnalyzeFlags): ScanParams {
    const minN = flags.minN ? Number.parseInt(flags.minN, 10) : 2;
    const maxN = flags.maxN ? Number.parseInt(flags.maxN, 10) : 4;
    const threshold = flags.threshold ? Number.parseInt(flags.threshold, 10) : 3;
    const top = flags.top ? Number.parseInt(flags.top, 10) : 20;

    return {
        minN: Number.isNaN(minN) ? 2 : minN,
        maxN: Number.isNaN(maxN) ? 4 : maxN,
        threshold: Number.isNaN(threshold) ? 3 : threshold,
        top: Number.isNaN(top) ? 20 : top,
    };
}

export function defaultRcFile(): string {
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

export { BLOCK_END, BLOCK_START };
