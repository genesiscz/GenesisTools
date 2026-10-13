import { env } from "@genesiscz/utils/env";
import { FriendlyError } from "./errors";
import type { AgentRecord } from "./types";

/** Registry meta key: the Codex thread that owns a `tools codex spawn` worker's bus identity. */
export const OWNER_THREAD_META_KEY = "codexThreadId";

/**
 * Refuse a bus identity used from a Codex thread other than the one that owns it.
 *
 * A native subagent inherits its parent worker's developer instructions, so it runs the parent's seeded bus
 * commands under the parent's name: its `login --once` shares the parent's cursor and drains the parent's
 * mailbox, and its sends read as the parent's (observed 2026-10-13). Codex sets CODEX_THREAD_ID to the
 * executing thread in every shell it starts, the subagent's own id included, so the registering thread is
 * the only one allowed to act as the identity. Identities without an owner, and shells outside Codex, pass.
 */
export function assertOwnerThread(record: AgentRecord, processEnv: NodeJS.ProcessEnv = env.getProcessEnv()): void {
    const owner = record.meta[OWNER_THREAD_META_KEY];
    const current = processEnv.CODEX_THREAD_ID;

    if (typeof owner !== "string" || !current || current === owner) {
        return;
    }

    throw new FriendlyError(
        `"${record.agent_name}" belongs to Codex thread ${owner}; this shell runs in thread ${current}, a native subagent of it`,
        "A subagent never uses its parent's bus identity. Report to the parent agent through native collaboration instead."
    );
}
