import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

/** Archive every board THIS run created (tracked via freshBoard() in boards-test-api.ts into the
 *  PW_RUN_SLUGS_FILE set up by global-setup.ts) so concurrent spec runs sharing the strict-port
 *  singleton dev-dashboard server (localhost:3042) don't archive each other's boards. Archive,
 *  not delete — the server has no hard-delete and the data stays recoverable. */
export default async function globalTeardown(): Promise<void> {
    const slugsFile = process.env.PW_RUN_SLUGS_FILE;

    if (!slugsFile || !existsSync(slugsFile)) {
        return;
    }

    try {
        const created = new Set(
            readFileSync(slugsFile, "utf8")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
        );

        if (created.size === 0) {
            return;
        }

        const base = env.dashboard.getQaBaseUrl();
        const res = await fetch(`${base}/api/boards`);

        if (!res.ok) {
            logger.warn({ status: res.status }, "[boards tests] teardown GET /api/boards failed");
            return;
        }

        const { boards } = SafeJSON.parse(await res.text(), { strict: true }) as {
            boards: Array<{ slug: string; archived: boolean }>;
        };

        for (const board of boards) {
            if (!created.has(board.slug) || board.archived) {
                continue;
            }

            const patchRes = await fetch(`${base}/api/boards/${board.slug}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ archived: true }),
            });

            if (!patchRes.ok) {
                logger.warn(
                    { slug: board.slug, status: patchRes.status },
                    "[boards tests] teardown archive PATCH failed"
                );
            }
        }
    } catch (err) {
        logger.warn({ err }, "[boards tests] teardown archive sweep failed");
    } finally {
        unlinkSync(slugsFile);
    }
}
