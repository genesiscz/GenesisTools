import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    BLOCK_END,
    BLOCK_START,
    extractHotPaths,
    type HotPath,
    isWorthAliasing,
    parseHistory,
    suggestAlias,
    updateLevel,
} from "@app/aliases/lib/core";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
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

export interface AliasState {
    paths: Record<string, PathState>;
}

export interface ScanParams {
    minN: number;
    maxN: number;
    threshold: number;
    chainThreshold: number;
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
    chainThreshold?: string;
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

export function emptyState(): AliasState {
    return { paths: {} };
}

export async function readState(): Promise<AliasState> {
    const file = statePath();
    if (!existsSync(file)) {
        return emptyState();
    }

    try {
        const text = await Bun.file(file).text();
        const parsed = SafeJSON.parse(text) as AliasState;
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
    const envHist = env.paths.getHistfile();
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
 * Mine history, extract hot paths, and update alias-level state (unless
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

    // Single commands need to repeat more (default 3) to be worth aliasing,
    // but chains are inherently rarer and a lower threshold (default 2)
    // surfaces useful ones we'd otherwise miss. Single call so subsumption
    // (drop `z genesistools` when `z genesistools && ccc` has the same count)
    // still works.
    const hot = extractHotPaths({
        commands,
        minN: opts.params.minN,
        maxN: opts.params.maxN,
        threshold: opts.params.threshold,
        chainThreshold: opts.params.chainThreshold,
        top: opts.params.top,
    });

    const nowIso = new Date(opts.now).toISOString();
    const taken = new Set<string>();

    let reportPaths: ReportPath[];

    if (opts.noState) {
        reportPaths = hot.map((path: HotPath) => {
            const key = path.commands.join(" ");
            const level = updateLevel({ level: 0, reused: true, daysSince: 0 });
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
        const nextState = await storage.atomicUpdate<AliasState>(STATE_FILE, (current) => {
            const next: AliasState = current?.paths ? current : emptyState();
            for (const path of hot) {
                const key = path.commands.join(" ");
                const priorPath = next.paths[key];
                const level = updateLevel({
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
    const worth = report.paths.filter((p) => isWorthAliasing({ commands: p.commands, aliasName: p.alias.name }));
    const trivial = report.paths.length - worth.length;
    const trivialNote = trivial > 0 ? ` (${trivial} skipped as too short to alias)` : "";
    lines.push(`mined ${report.counts.lines.toLocaleString("en")} lines · ${worth.length} hot commands${trivialNote}`);
    lines.push("");

    if (worth.length === 0) {
        lines.push("No hot command sequences worth aliasing.");
        return lines.join("\n");
    }

    const suggested = worth.filter((p) => p.level >= minLevel);

    // Column widths from the worth-aliasing rows (which dominate the display).
    const chainStrings = worth.map((p) => p.commands.join(" && "));
    const maxChain = chainStrings.reduce((max, s) => Math.max(max, s.length), 0);
    const maxCount = worth.reduce((max, p) => Math.max(max, String(p.count).length), 0);
    const maxAlias = worth.reduce((max, p) => Math.max(max, p.alias.name.length), 0);

    lines.push("HOT COMMANDS (sorted by reuse × chain length)");
    for (const path of worth) {
        const chain = path.commands.join(" && ").padEnd(maxChain);
        const count = `×${String(path.count).padStart(maxCount)}`;
        const level = `lvl ${path.level.toFixed(1)}`;
        const alias = path.level >= minLevel ? `→ ${path.alias.name.padEnd(maxAlias)} ★` : `→ ${path.alias.name}`;
        lines.push(`  ${bar(path.level)}  ${chain}  ${count}  ${level}  ${alias}`.trimEnd());
    }

    lines.push("");

    if (suggested.length > 0) {
        lines.push(`READY TO APPLY (level ≥ ${minLevel}, marked ★ above)`);
        for (const path of suggested) {
            lines.push(`  alias ${path.alias.name}='${escapeForSingleQuote(path.alias.command)}'`);
        }

        lines.push("");
        lines.push(
            `Run \`tools aliases apply\` to write ${suggested.length} alias${suggested.length === 1 ? "" : "es"} to your rc.`
        );
    } else if (worth.length > 0) {
        lines.push(
            `No aliases at level ≥ ${minLevel} yet — re-run \`tools aliases\` after using these more to raise levels.`
        );
    }

    return lines.join("\n");
}

export function parseParams(flags: AnalyzeFlags): ScanParams {
    // Mirror the clamping rules inside `extractHotPaths` so the report params
    // describe what the scan ACTUALLY ran — without this, e.g. `--min-n 5
    // --max-n 2` would be reported as `5..2` even though extraction silently
    // executes 5..5.
    const rawMinN = flags.minN ? Number.parseInt(flags.minN, 10) : 1;
    const rawMaxN = flags.maxN ? Number.parseInt(flags.maxN, 10) : 4;
    const rawThreshold = flags.threshold ? Number.parseInt(flags.threshold, 10) : 3;
    const rawChainThreshold = flags.chainThreshold ? Number.parseInt(flags.chainThreshold, 10) : 2;
    const rawTop = flags.top ? Number.parseInt(flags.top, 10) : 20;

    const minN = Math.max(1, Number.isNaN(rawMinN) ? 1 : rawMinN);
    const maxN = Math.max(minN, Number.isNaN(rawMaxN) ? 4 : rawMaxN);
    const threshold = Math.max(1, Number.isNaN(rawThreshold) ? 3 : rawThreshold);
    const chainThreshold = Math.max(1, Number.isNaN(rawChainThreshold) ? 2 : rawChainThreshold);
    const top = Math.max(0, Number.isNaN(rawTop) ? 20 : rawTop);

    return { minN, maxN, threshold, chainThreshold, top };
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
