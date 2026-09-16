import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { createGit } from "@genesiscz/utils/git/core";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { killWithEscalation } from "@genesiscz/utils/process/killWithEscalation";
import { StatuslineCache } from "./cache";
import { buildLine, terminalWidth } from "./layout";
import {
    accountSegment,
    contextSegment,
    deltaSegment,
    dirtySegment,
    gitSegment,
    modelDirSegment,
    modelLabel,
    sessionSegment,
} from "./segments";
import type { RenderResult, RenderTimings, StatuslineConfig, StatuslineFeature, StatuslinePayload } from "./types";

/**
 * Turn one host payload into the lines the host prints. Every external cost the shell script paid
 * per render (two transcript tails piped to jq, two git processes, a jq over `~/.claude.json`, a
 * `ps` ancestor walk, a `tools claude info` bun launch, a `node` for the graft line, `tput`) is
 * either answered in-process or served from `StatuslineCache` until its source changes.
 */
export interface RenderDeps {
    feature: StatuslineFeature;
    config: StatuslineConfig;
    cache?: StatuslineCache;
    /** Terminal width override; the default detects it. */
    columns?: number;
    now?: () => number;
}

export interface GitInfo {
    branch: string | null;
    dirty: number;
}

/** A hung `git status` must not freeze every Claude statusline on the machine. */
const GIT_STATUS_TIMEOUT_MS = 5_000;
const SPAWN_KILL_GRACE_MS = 250;

export async function renderStatusline(raw: Record<string, unknown>, deps: RenderDeps): Promise<RenderResult> {
    const timings: RenderTimings = {};
    const time = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now();

        try {
            return await work();
        } finally {
            timings[step] = Math.round((performance.now() - startedAt) * 100) / 100;
        }
    };
    const payload = deps.feature.parsePayload(raw);

    if (!payload) {
        throw new Error(`the payload is not a ${deps.feature.host} statusline document`);
    }

    const cache = deps.cache ?? new StatuslineCache();
    const config = deps.config;
    const now = deps.now ?? Date.now;

    if (payload.isAgentFrame) {
        const graft = config.graft.enabled ? await time("graft", () => graftLine(payload, config, cache, now)) : "";

        return { lines: graft ? [graft] : [], timings, settled: Promise.resolve() };
    }

    const [model, lastMessageTime, sessionName, account, autocompact, git, graft, extension] = await Promise.all([
        // The transcript's id first: the host's field lags a `/model` switch by a whole turn.
        time("model", async () => (await deps.feature.resolveModel?.(payload)) ?? payload.modelId ?? null),
        time("lastMessage", async () => (await deps.feature.resolveLastMessageTime?.(payload)) ?? null),
        time(
            "sessionName",
            async () => (config.showSession ? await deps.feature.resolveSessionName?.(payload) : null) ?? null
        ),
        time("account", async () => (config.showAccount ? await deps.feature.resolveAccount?.(payload) : null) ?? null),
        time("autocompact", async () => (await deps.feature.resolveAutocompact?.()) ?? true),
        time("git", async () => (config.showGit ? gitInfo(payload.cwd, config, cache, now) : null)),
        time("graft", async () => (config.graft.enabled ? graftLine(payload, config, cache, now) : "")),
        time("extension", async () => (config.extends ? runExtension(payload, config) : [])),
    ]);

    const line1Parts = [
        modelDirSegment(modelLabel(model, payload.modelDisplayName, config.modelStyle), basename(payload.cwd)),
        gitSegment(git?.branch ?? null),
    ];
    const line2Parts: string[] = [config.showDirty ? dirtySegment(git?.branch ?? null, git?.dirty ?? 0) : ""];

    if (payload.contextWindowSize && payload.usage) {
        const usedTokens =
            payload.usage.inputTokens + payload.usage.cacheCreationTokens + payload.usage.cacheReadTokens;
        const context = contextSegment({ usedTokens, contextWindowSize: payload.contextWindowSize, autocompact });
        line2Parts.push(context.context);

        if (config.showDelta && payload.sessionId) {
            line2Parts.push(deltaSegment(tokenDelta(cache, payload.sessionId, usedTokens, now)));
        }

        line2Parts.push(context.ac);
    }

    if (config.showSession && payload.sessionId) {
        line2Parts.push(sessionSegment({ sessionId: payload.sessionId, sessionName, lastMessageTime }));
    }

    if (account) {
        line2Parts.push(accountSegment(account, now()));
    }

    const maxWidth = (deps.columns ?? terminalWidth(config.fallbackColumns)) - 2;
    const line1 = buildLine(line1Parts, maxWidth);
    const line2 = buildLine(line2Parts, maxWidth);
    const lines = line2 ? [line1, line2] : [line1];
    const before = extension.filter((entry) => entry.position === "before").flatMap((entry) => entry.lines);
    const after = extension.filter((entry) => entry.position === "after").flatMap((entry) => entry.lines);

    if (graft) {
        after.push(graft);
    }

    let settled: Promise<void> = Promise.resolve();

    if (config.metricsPost.enabled && payload.sessionId) {
        // Bounded by `metricsPost.timeoutMs`. The hot entry must not await this before exit.
        settled = postMetrics(payload, config).catch((error) => {
            logger.debug({ err: error, url: config.metricsPost.url }, "statusline metrics post failed");
        });
    }

    return { lines: [...before, ...lines, ...after], timings, settled };
}

/** The previous render's token count for this session, replaced by the current one. */
function tokenDelta(cache: StatuslineCache, sessionId: string, usedTokens: number, now: () => number): number {
    const entry = cache.session(sessionId);
    const delta = entry.prevTokens === undefined ? 0 : usedTokens - entry.prevTokens;

    if (entry.prevTokens !== usedTokens) {
        cache.writeSession(sessionId, { prevTokens: usedTokens, prevAt: now() });
    }

    return delta;
}

interface GitLayout {
    worktreeRoot: string;
    gitDir: string;
}

/**
 * Walk up from `cwd` until `.git` is a directory or a `gitdir:` file (linked worktrees).
 * Nested packages and worktrees both resolve; a missing `cwd/.git` is not "not a repo".
 */
export function resolveGitLayout(cwd: string): GitLayout | null {
    let dir = cwd;

    for (;;) {
        const candidate = join(dir, ".git");

        if (existsSync(candidate)) {
            try {
                const st = statSync(candidate);

                if (st.isDirectory()) {
                    return { worktreeRoot: dir, gitDir: candidate };
                }

                if (st.isFile()) {
                    const text = readFileSync(candidate, "utf8");
                    const match = /^gitdir:\s*(.+)\s*$/m.exec(text);

                    if (match?.[1]) {
                        const gitDir = isAbsolute(match[1]) ? match[1] : resolve(dir, match[1]);

                        if (existsSync(gitDir)) {
                            return { worktreeRoot: dir, gitDir };
                        }
                    }
                }
            } catch (error) {
                logger.debug({ err: error, candidate }, "statusline: .git unreadable");
            }
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
}

function branchFromHead(gitDir: string): string | null {
    try {
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s+refs\/heads\/(.+)$/.exec(head);

        return ref?.[1] ?? null;
    } catch (error) {
        logger.debug({ err: error, gitDir }, "statusline: HEAD unreadable");

        return null;
    }
}

/**
 * Branch (and dirty count when asked). Default path is a HEAD file read: no `git status`,
 * no work-tree walk. Porcelain runs only when `showDirty` is on. Cache is keyed on the
 * worktree root so a nested cwd shares the branch with the repo.
 */
export async function gitInfo(
    cwd: string,
    config: StatuslineConfig,
    cache: StatuslineCache,
    now: () => number
): Promise<GitInfo | null> {
    const layout = resolveGitLayout(cwd);

    if (!layout) {
        return null;
    }

    const { worktreeRoot, gitDir } = layout;
    const headMtime = mtimeOf(join(gitDir, "HEAD"));
    const indexMtime = mtimeOf(join(gitDir, "index"));
    const cached = cache.cwd(worktreeRoot);

    if (
        cached &&
        now() - cached.at < config.gitTtlMs &&
        cached.headMtime === headMtime &&
        cached.indexMtime === indexMtime
    ) {
        return { branch: cached.branch, dirty: cached.dirty };
    }

    const branch = branchFromHead(gitDir);

    if (!config.showDirty) {
        cache.writeCwdPatch(worktreeRoot, {
            branch,
            dirty: 0,
            at: now(),
            headMtime,
            indexMtime,
        });

        return { branch, dirty: 0 };
    }

    try {
        const status = await createGit({ cwd: worktreeRoot }).status({
            cwd: worktreeRoot,
            untracked: "normal",
            timeout: GIT_STATUS_TIMEOUT_MS,
        });
        const head = status.branch?.head;
        const statusBranch = head && head !== "HEAD" && head !== "(detached)" ? head : branch;
        const dirty = status.entries.length;
        cache.writeCwdPatch(worktreeRoot, {
            branch: statusBranch,
            dirty,
            at: now(),
            headMtime,
            indexMtime,
        });

        return { branch: statusBranch, dirty };
    } catch (error) {
        logger.debug({ err: error, cwd: worktreeRoot }, "statusline git status failed");
        cache.writeCwdPatch(worktreeRoot, {
            branch,
            dirty: cached?.dirty ?? 0,
            at: now(),
            headMtime,
            indexMtime,
        });

        return { branch, dirty: cached?.dirty ?? 0 };
    }
}

function mtimeOf(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch (error) {
        logger.debug({ err: error, path }, "statusline: stat failed, treating as absent");

        return 0;
    }
}

/**
 * graft's own line for a checkout that has a graph, exactly as `statusline-graft.sh` produced
 * it: the shim gets the payload without `context_window`, and lines carrying `▸` are dropped.
 * Cached per cwd for `graft.ttlMs`, so the node process runs once per interval, not per render.
 */
async function graftLine(
    payload: StatuslinePayload,
    config: StatuslineConfig,
    cache: StatuslineCache,
    now: () => number
): Promise<string> {
    const processEnv = env.getProcessEnv();
    const dir = processEnv.CLAUDE_PROJECT_DIR || payload.cwd;
    const graph = join(processEnv.GRAFT_DIR || join(dir, "graft"), ".graph", "wiring.json");

    if (!existsSync(graph) || !existsSync(config.graft.shim)) {
        return "";
    }

    const cached = cache.cwd(payload.cwd);

    if (
        cached?.graftLine !== undefined &&
        cached.graftAt !== undefined &&
        now() - cached.graftAt < config.graft.ttlMs
    ) {
        return cached.graftLine;
    }

    const withoutContext: Record<string, unknown> = { ...payload.raw };
    delete withoutContext.context_window;
    const proc = Bun.spawn(["node", config.graft.shim], {
        stdin: new TextEncoder().encode(stringifyRaw(withoutContext)),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...processEnv, CLAUDE_PROJECT_DIR: dir },
    });
    const stdout = await readSpawnStdout(proc, 2_000);
    const line = stdout
        .split("\n")
        .filter((entry) => entry.trim() && !entry.includes("▸"))
        .join("\n");
    cache.writeCwdPatch(payload.cwd, {
        graftLine: line,
        graftAt: now(),
    });

    return line;
}

function stringifyRaw(value: Record<string, unknown>): string {
    return SafeJSON.stringify(value, { strict: true });
}

interface ExtensionOutput {
    position: "before" | "after";
    lines: string[];
}

/** Run another statusline script with the raw payload on stdin and keep its lines. */
async function runExtension(payload: StatuslinePayload, config: StatuslineConfig): Promise<ExtensionOutput[]> {
    const extension = config.extends;

    if (!extension) {
        return [];
    }

    const proc = Bun.spawn(["/bin/sh", "-c", extension.command], {
        stdin: new TextEncoder().encode(stringifyRaw(payload.raw)),
        stdout: "pipe",
        stderr: "pipe",
        env: env.getProcessEnv(),
    });
    const stdout = await readSpawnStdout(proc, extension.timeoutMs);
    const lines = stdout.split("\n").filter((entry) => entry.length > 0);

    return lines.length > 0 ? [{ position: extension.position, lines }] : [];
}

async function readSpawnStdout(proc: Bun.Subprocess, timeoutMs: number): Promise<string> {
    const killer = setTimeout(() => {
        void killWithEscalation(proc, { graceMs: SPAWN_KILL_GRACE_MS });
    }, timeoutMs);

    try {
        const stream = proc.stdout;

        if (!(stream instanceof ReadableStream)) {
            await proc.exited;

            return "";
        }

        const [stdout] = await Promise.all([new Response(stream).text(), proc.exited]);

        return stdout;
    } catch (error) {
        logger.debug({ err: error }, "statusline: spawn stdout read failed");

        return "";
    } finally {
        clearTimeout(killer);
    }
}

async function postMetrics(payload: StatuslinePayload, config: StatuslineConfig): Promise<void> {
    await fetch(config.metricsPost.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stringifyRaw(payload.raw),
        signal: AbortSignal.timeout(config.metricsPost.timeoutMs),
    });
}
