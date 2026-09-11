import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pickLaunchAccount } from "@app/ai/lib/accounts/pick-launch-account";
import { formatHistoryMarkdown } from "@genesiscz/utils/agent-sessions/format-history";
import { createNativeHistoryAdapter } from "@genesiscz/utils/agent-sessions/native-adapter";
import { selectResumeSession } from "@genesiscz/utils/agent-sessions/select-resume";
import type { AgentSession, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import type { AgentToolSpec } from "./spec";
import { toolName } from "./spec";

/** What `run` and `resume` both hand to the one launch path. */
export interface AgentLaunchRequest {
    /** The account the user named, if any; the picker runs otherwise. */
    account?: string;
    /** A query resolves through the shared selector; `true` is the native picker. */
    resume?: string | boolean;
    continueLast?: boolean;
    model?: string;
    all?: boolean;
    cwd?: string;
    /** `--list`: print the matching sessions instead of launching. */
    list?: boolean;
    limit?: number;
    passthrough: string[];
    flags: Record<string, unknown>;
    /** The door being used, for non-interactive hints: `["run"]` or `["resume"]`. */
    subcommand: string[];
}

/** Injected by tests; the defaults are the real picker and adapter. */
export interface AgentLaunchDeps {
    pickAccount: (input: {
        spec: AgentToolSpec;
        requested?: string;
        subcommand: string[];
    }) => Promise<AccountEntry | null>;
}

const defaultDeps: AgentLaunchDeps = {
    pickAccount: ({ spec, requested, subcommand }) =>
        pickLaunchAccount({
            alias: spec.alias,
            // `suggestCommand` strips `subcommand` from argv because it expects those words to be
            // in the tool name already. Passing the bare tool printed `tools codex <account>`,
            // which is not a command.
            tool: [toolName(spec), ...subcommand].join(" "),
            subcommand,
            ...(requested === undefined ? {} : { requested }),
        }),
};

export function adapterOf(spec: AgentToolSpec): AgentSessionAdapter {
    return spec.adapter?.() ?? createNativeHistoryAdapter({ kind: spec.alias, provider: spec.provider });
}

/**
 * The directory a resumed session opens in. 39% of indexed sessions name a directory that
 * is gone (a deleted worktree), and a raw ENOENT out of the spawn said nothing useful.
 */
export function resolveLaunchCwd(session: AgentSession | undefined, requested: string): string {
    if (!session?.cwd || session.cwd === requested) {
        return requested;
    }

    if (existsSync(session.cwd)) {
        return session.cwd;
    }

    out.log.warn(`The session's directory ${session.cwd} no longer exists; opening in ${requested} instead.`);
    return requested;
}

/**
 * The one launch path behind `tools <agent> run` and `tools <agent> resume`.
 *
 * Order: the launcher's preflight (argv it refuses, compatibility routes), then the session
 * when a query was given (so a query with no match fails before anyone is asked to pick an
 * account), then the account, then the launcher. Every failure sets `process.exitCode` and
 * returns; nothing here calls `process.exit`, so a launcher's cleanup always runs.
 */
export async function launchAgent(
    spec: AgentToolSpec,
    request: AgentLaunchRequest,
    deps: AgentLaunchDeps = defaultDeps
): Promise<void> {
    const { launcher } = spec;
    const handled = await launcher.preflight?.({ flags: request.flags, passthrough: request.passthrough });

    if (handled === "handled") {
        return;
    }

    const cwd = resolve(request.cwd ?? process.cwd());
    const query = typeof request.resume === "string" ? request.resume : undefined;
    let session: AgentSession | undefined;

    if (query !== undefined || request.list) {
        const scope = (await launcher.resumeScope?.({ flags: request.flags })) ?? { adapter: adapterOf(spec) };
        const filters = { cwd: request.all ? undefined : cwd, all: Boolean(request.all), limit: request.limit ?? 20 };

        if (request.list) {
            const sessions = query
                ? await scope.adapter.search({ ...filters, query })
                : await scope.adapter.list(filters);
            out.print(formatHistoryMarkdown(sessions, query));
            return;
        }

        try {
            session = await selectResumeSession({
                adapter: scope.adapter,
                query: query as string,
                filters,
                ...(scope.preferredHome === undefined ? {} : { preferredHome: scope.preferredHome }),
            });
        } catch (error) {
            logger.debug({ error, query, alias: spec.alias }, "[agent] resume query did not resolve");
            out.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
            return;
        }

        if (!session) {
            return;
        }
    }

    const account = await deps.pickAccount({
        spec,
        subcommand: request.subcommand,
        ...(request.account === undefined ? {} : { requested: request.account }),
    });

    if (!account) {
        return;
    }

    if (session) {
        out.println(pc.dim(`Resuming ${spec.alias} ${session.sessionId.slice(0, 8)} (${session.title})`));
    }

    await launcher.launch({
        account,
        ...(session === undefined ? {} : { session }),
        nativeResume: request.resume === true,
        continueLast: request.continueLast === true,
        ...(request.model === undefined ? {} : { model: request.model }),
        cwd: resolveLaunchCwd(session, cwd),
        passthrough: request.passthrough,
        flags: request.flags,
    });
}
