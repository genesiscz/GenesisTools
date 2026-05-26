import * as p from "@clack/prompts";
import { buildTimestampedSessionName } from "@app/task/lib/session-name";
import type { TaskSessionStore } from "@app/task/lib/session-store";
import type { ResolvedRunSession, SessionReuseMode } from "@app/task/types";

export interface ResolveRunSessionOptions {
    /** Explicit --session flag: reuse-continue with warnings, no prompt. */
    explicitSessionFlag: boolean;
    interactive: boolean;
}

async function resolvePrefixedSession(store: TaskSessionStore, requested: string): Promise<ResolvedRunSession> {
    let session = buildTimestampedSessionName(requested);

    while (store.sessionFilesExist(session)) {
        await Bun.sleep(1100);
        session = buildTimestampedSessionName(requested);
    }

    return { session, requested, renamed: true, reuse: "prefix" };
}

async function promptReuseChoice(requested: string): Promise<SessionReuseMode | null> {
    const choice = await p.select({
        message: `Existing session "${requested}". Re-use or prefix?`,
        options: [
            { value: "reuse-clear" as const, label: "Re-use and clear" },
            { value: "reuse-continue" as const, label: "Re-use and continue" },
            { value: "prefix" as const, label: "Prefix and generate session" },
        ],
    });

    if (p.isCancel(choice)) {
        return null;
    }

    return choice;
}

export async function resolveRunSession(
    store: TaskSessionStore,
    requested: string,
    options: ResolveRunSessionOptions
): Promise<ResolvedRunSession | null> {
    await store.getSessionsDir();

    if (!store.sessionFilesExist(requested)) {
        return { session: requested, requested, renamed: false };
    }

    const previousLastSeq = await store.getLastLineSeq(requested);

    if (options.explicitSessionFlag) {
        return {
            session: requested,
            requested,
            renamed: false,
            reuse: "reuse-continue",
            previousLastSeq,
        };
    }

    if (!options.interactive) {
        return resolvePrefixedSession(store, requested);
    }

    const choice = await promptReuseChoice(requested);

    if (!choice) {
        return null;
    }

    if (choice === "prefix") {
        return resolvePrefixedSession(store, requested);
    }

    return {
        session: requested,
        requested,
        renamed: false,
        reuse: choice,
        previousLastSeq,
    };
}
