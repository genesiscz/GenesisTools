import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

/** Archive every board the suite created (pw-* slugs) so spec runs don't clutter the boards
 *  list. Archive, not delete — the server has no hard-delete and the data stays recoverable. */
export default async function globalTeardown(): Promise<void> {
    const base = env.dashboard.getQaBaseUrl();

    try {
        const res = await fetch(`${base}/api/boards`);

        if (!res.ok) {
            return;
        }

        const { boards } = (await res.json()) as { boards: Array<{ slug: string; archived: boolean }> };

        for (const board of boards) {
            if (board.slug.startsWith("pw-") && board.slug !== "pw-bug-lab" && !board.archived) {
                await fetch(`${base}/api/boards/${board.slug}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: SafeJSON.stringify({ archived: true }),
                });
            }
        }
    } catch (err) {
        console.warn("[boards tests] teardown archive sweep failed", err);
    }
}
