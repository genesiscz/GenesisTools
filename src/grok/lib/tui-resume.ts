import { formatHistoryMarkdown } from "@genesiscz/utils/agent-sessions/format-history";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { pickSessionByQuery } from "@genesiscz/utils/agent-sessions/pick-session";
import { resumeArgv } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { AgentSession, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { withCancel } from "@genesiscz/utils/prompts/clack/helpers";
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
    const filters = {
        cwd: opts.all ? undefined : process.cwd(),
        all: Boolean(opts.all),
        limit: opts.limit ?? 20,
        query: opts.query,
    };
    const sessions = opts.query ? await adapter.search(filters) : await adapter.list({ ...filters, query: undefined });

    if (opts.list) {
        out.print(formatHistoryMarkdown(sessions, opts.query));
        return undefined;
    }

    if (opts.query && sessions.length === 1) {
        return sessions[0];
    }

    const picked = pickSessionByQuery(sessions, opts.query);
    if (picked) {
        return picked;
    }

    if (!isInteractive()) {
        if (!opts.query) {
            out.error(
                `Pass a session id or title. ${suggestCommand("tools grok run --resume", { add: ["01a05cc5"] })}`
            );
            process.exitCode = 1;
            return undefined;
        }

        out.error(`No unique grok session matched "${opts.query}". Use --list to see candidates.`);
        process.exitCode = 1;
        return undefined;
    }

    if (sessions.length === 0) {
        out.error("No grok sessions found.");
        process.exitCode = 1;
        return undefined;
    }

    const p = await import("@clack/prompts");
    const choice = await withCancel(
        p.select({
            message: "Resume which grok session?",
            options: sessions.slice(0, opts.limit ?? 20).map((session) => ({
                value: session.sessionId,
                label: `${session.title} ${session.sessionId.slice(0, 8)}`,
                hint: session.cwd,
            })),
        })
    );

    return sessions.find((session) => session.sessionId === choice);
}

/**
 * The grok TUI is launched with the caller's environment, read through the env
 * facade rather than `process.env` (repo rule), so `env.testing.set()` reaches
 * this spawn like it reaches the worker's.
 */
export function buildGrokTuiSpawn(session: AgentSession): {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
} {
    return {
        cmd: grokTuiResumeArgv(resolveGrokBinary(), session.sessionId),
        cwd: session.cwd,
        env: env.getProcessEnv(),
    };
}

export async function launchGrokTui(session: AgentSession): Promise<never> {
    const proc = Bun.spawn({ ...buildGrokTuiSpawn(session), stdio: ["inherit", "inherit", "inherit"] });
    const code = await proc.exited;
    process.exit(code ?? 1);
}

export async function runGrokTuiResume(opts: TuiResumeOptions): Promise<void> {
    const session = await resolveGrokTuiSession(opts);
    if (!session) {
        return;
    }

    out.println(`Resuming grok ${session.sessionId.slice(0, 8)} (${session.title}) in ${session.cwd}`);
    await launchGrokTui(session);
}
