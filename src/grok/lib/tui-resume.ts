import { formatHistoryMarkdown } from "@genesiscz/utils/agent-sessions/format-history";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { resumeArgv } from "@genesiscz/utils/agent-sessions/resume-argv";
import { selectResumeSession } from "@genesiscz/utils/agent-sessions/select-resume";
import type { AgentSession, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { out } from "@genesiscz/utils/logger";
import { resolveGrokBinary } from "./worker";

export interface TuiResumeOptions {
    query?: string;
    list?: boolean;
    all?: boolean;
    limit?: number;
}

export function grokTuiResumeArgv(binary: string, sessionId: string): string[] {
    return [binary, ...resumeArgv("grok", sessionId).slice(1)];
}

export function parseResumeLimit(raw: string | undefined, fallback = 20): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }

    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`--limit must be a positive integer (got "${raw}")`);
    }

    const n = Number.parseInt(trimmed, 10);
    if (n < 1) {
        throw new Error(`--limit must be a positive integer (got "${raw}")`);
    }

    return n;
}

export async function resolveGrokTuiSession(
    opts: TuiResumeOptions,
    adapter: AgentSessionAdapter = createGrokAdapter()
): Promise<AgentSession | undefined> {
    const filters = { cwd: opts.all ? undefined : process.cwd(), all: Boolean(opts.all), limit: opts.limit ?? 20 };
    if (opts.list) {
        const sessions = opts.query
            ? await adapter.search({ ...filters, query: opts.query })
            : await adapter.list(filters);
        out.print(formatHistoryMarkdown(sessions, opts.query));
        return undefined;
    }
    if (!opts.query) {
        out.error(`Pass a session query, or use native bare resume. ${suggestCommand("tools grok run --resume")}`);
        process.exitCode = 1;
        return undefined;
    }
    try {
        return await selectResumeSession({ adapter, query: opts.query, filters });
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return undefined;
    }
}

/**
 * The grok TUI is launched with the caller's environment, read through the env
 * facade rather than `process.env` (repo rule), so `env.testing.set()` reaches
 * this spawn like it reaches the worker's.
 */
export function buildGrokTuiSpawn(options: { session?: AgentSession; binary: string }): {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
} {
    const { session, binary } = options;
    return {
        cmd: session ? grokTuiResumeArgv(binary, session.sessionId) : [binary, "--resume"],
        cwd: session?.cwd ?? process.cwd(),
        env: { ...env.getProcessEnv(), ...(session?.sourceHome ? { GROK_HOME: session.sourceHome } : {}) },
    };
}

export async function launchGrokTui(session?: AgentSession): Promise<never> {
    // A worker home is isolated on purpose and carries no subscription login, so resuming a
    // worker transcript in the interactive TUI would otherwise fall back to metered XAI_API_KEY
    // billing without saying so.
    if (session?.sourceHome?.startsWith(grokRoot())) {
        out.log.warn(
            `This session lives in the managed worker home ${session.sourceHome}, which has no subscription login. The interactive session will use XAI_API_KEY billing if it authenticates at all.`
        );
    }

    const proc = Bun.spawn({
        ...buildGrokTuiSpawn({ session, binary: resolveGrokBinary() }),
        stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    process.exit(code ?? 1);
}

export async function runGrokTuiResume(opts: TuiResumeOptions): Promise<void> {
    if (!opts.query && !opts.list) {
        await launchGrokTui();
        return;
    }
    const session = await resolveGrokTuiSession(opts);
    if (!session) {
        return;
    }

    out.println(`Resuming grok ${session.sessionId.slice(0, 8)} (${session.title}) in ${session.cwd}`);
    await launchGrokTui(session);
}
