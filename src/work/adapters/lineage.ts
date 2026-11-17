import { t3SessionThreads } from "@genesiscz/utils/t3code/session-threads";
import type { LineageResolver } from "@genesiscz/utils/work/ports";

/** A delegated T3 child's lead: the native sessions of its parent thread. */
export function t3Lineage(): LineageResolver {
    return {
        async leadSessions({ sessionId, parentThreadId }) {
            const threads = t3SessionThreads();
            const parent = parentThreadId ?? (sessionId !== null ? (threads.get(sessionId)?.parent?.id ?? null) : null);

            if (parent === null) {
                return [];
            }

            const leads: string[] = [];

            for (const [native, thread] of threads) {
                if (thread.threadId === parent) {
                    leads.push(native);
                }
            }

            return leads;
        },
    };
}
