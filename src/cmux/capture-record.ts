import { associateCapturedSurface, recordCapturedCommand } from "@app/cmux/lib/capture-journal";
import { resolveCapturedSurfaceIdentity } from "@app/cmux/lib/capture-surface-identity";
import { logger } from "@genesiscz/utils/logger";

const [phase, surfaceId, cwd, workspaceId, exitStatus, directory] = process.argv.slice(2);

try {
    if (phase === "--associate") {
        for (let attempt = 0; attempt < 15; attempt++) {
            const stableSurfaceId = resolveCapturedSurfaceIdentity({ surfaceId, journalDirectory: cwd || undefined });
            if (stableSurfaceId) {
                associateCapturedSurface({ surfaceId, stableSurfaceId, directory: cwd || undefined });
                process.exit(0);
            }
            await Bun.sleep(2000);
        }
        logger.debug({ surfaceId }, "[cmux-capture] identity association deferred until a later shell event");
        process.exit(0);
    }
    if (phase !== "running" && phase !== "completed") {
        throw new Error("Expected running or completed capture event");
    }

    recordCapturedCommand({
        phase,
        surfaceId,
        stableSurfaceId: resolveCapturedSurfaceIdentity({ surfaceId, journalDirectory: directory || undefined }),
        cwd,
        workspaceId: workspaceId || undefined,
        exitStatus: exitStatus ? Number(exitStatus) : undefined,
        directory: directory || undefined,
        command: await Bun.stdin.text(),
    });
} catch (error) {
    logger.error({ error }, "[cmux-capture] could not persist shell command");
    process.exitCode = 1;
}
