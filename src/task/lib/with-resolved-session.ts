import { out } from "@app/logger";
import { TaskSessionStore } from "@app/task/lib/session-store";

export async function withResolvedSession(
    sessionFlag: string | undefined,
    run: (session: string) => Promise<void>
): Promise<void> {
    const store = new TaskSessionStore();

    try {
        const session = await store.resolveSession(sessionFlag);

        if (!sessionFlag) {
            out.printlnErr(`(auto-resolved session: ${session})`);
        }

        await run(session);
    } catch (err) {
        out.printlnErr(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
