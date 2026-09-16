import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createGit } from "@genesiscz/utils/git/core";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CwdCacheEntry, StatuslineCache } from "./cache";
import { buildLine, terminalWidth } from "./layout";
import {
    accountSegment,
    contextSegment,
    deltaSegment,
    dirtySegment,
    gitSegment,
    modelDirSegment,
    sessionSegment,
    shortModel,
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

interface GitInfo {
    branch: string | null;
    dirty: number;
}

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
        time("model", async () => (await deps.feature.resolveModel?.(payload)) ?? payload.modelDisplayName ?? "Claude"),
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

    const line1Parts = [modelDirSegment(shortModel(model), basename(payload.cwd)), gitSegment(git?.branch ?? null)];
    const line2Parts: string[] = [dirtySegment(git?.branch ?? null, git?.dirty ?? 0)];

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
        // Bounded by `metricsPost.timeoutMs`; the old script backgrounded a curl per render for this.
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

/**
 * Branch and dirty count, reused for `gitTtlMs` unless `.git/HEAD` or the index changed. One
 * typed `git status --porcelain=v2 --branch` call replaces the script's `rev-parse` plus
 * `status --porcelain | wc -l`, and most renders make no git call at all.
 */
async function gitInfo(
    cwd: string,
    config: StatuslineConfig,
    cache: StatuslineCache,
    now: () => number
): Promise<GitInfo | null> {
    const gitDir = join(cwd, ".git");

    if (!existsSync(gitDir)) {
        return null;
    }

    const headMtime = mtimeOf(join(gitDir, "HEAD"));
    const indexMtime = mtimeOf(join(gitDir, "index"));
    const cached = cache.cwd(cwd);

    if (
        cached &&
        now() - cached.at < config.gitTtlMs &&
        cached.headMtime === headMtime &&
        cached.indexMtime === indexMtime
    ) {
        return { branch: cached.branch, dirty: cached.dirty };
    }

    try {
        const status = await createGit({ cwd }).status({ cwd, untracked: "normal" });
        const branch = status.branch?.head || null;
        const entry: CwdCacheEntry = {
            branch,
            dirty: status.entries.length,
            at: now(),
            headMtime,
            indexMtime,
            ...(cached?.graftLine === undefined ? {} : { graftLine: cached.graftLine, graftAt: cached.graftAt }),
        };
        cache.writeCwd(cwd, entry);

        return { branch, dirty: entry.dirty };
    } catch (error) {
        logger.debug({ err: error, cwd }, "statusline git status failed");

        return null;
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
    const dir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
    const graph = join(process.env.GRAFT_DIR || join(dir, "graft"), ".graph", "wiring.json");

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
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    const killer = setTimeout(() => proc.kill(), 2_000);
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(killer);
    const line = stdout
        .split("\n")
        .filter((entry) => entry.trim() && !entry.includes("▸"))
        .join("\n");
    const previous = cache.cwd(payload.cwd);
    cache.writeCwd(payload.cwd, {
        branch: previous?.branch ?? null,
        dirty: previous?.dirty ?? 0,
        at: previous?.at ?? 0,
        headMtime: previous?.headMtime ?? 0,
        indexMtime: previous?.indexMtime ?? 0,
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
        env: process.env,
    });
    const killer = setTimeout(() => proc.kill(), extension.timeoutMs);
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(killer);
    const lines = stdout.split("\n").filter((entry) => entry.length > 0);

    return lines.length > 0 ? [{ position: extension.position, lines }] : [];
}

async function postMetrics(payload: StatuslinePayload, config: StatuslineConfig): Promise<void> {
    await fetch(config.metricsPost.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stringifyRaw(payload.raw),
        signal: AbortSignal.timeout(config.metricsPost.timeoutMs),
    });
}
