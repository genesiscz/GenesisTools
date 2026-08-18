import { claudeAncestorCommand } from "@app/claude/lib/cmux/ancestry";
import { parseHookPayload } from "@app/claude/lib/cmux/hook";
import { recordPin } from "@app/claude/lib/cmux/pins";
import { modelFromArgv } from "@app/claude/lib/doctor";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/**
 * SessionStart hook body: read Claude Code's hook payload from stdin and write the
 * `session id → account` pin.
 *
 * It runs on every session start, resume, clear and compact, so it is deliberately
 * silent and never fails: a hook that errors would print noise into the user's
 * session for a bookkeeping record nobody asked for at that moment.
 */
export async function recordCommand(): Promise<void> {
    try {
        const payload = parseHookPayload(await Bun.stdin.text());

        if (!payload?.session_id) {
            logger.debug("[claude-cmux] hook payload had no session_id — nothing to pin");
            return;
        }

        const command = await claudeAncestorCommand();
        const account = env.claudeCode.getPinnedAccount() ?? null;

        await recordPin({
            sessionId: payload.session_id,
            account,
            model: command ? (modelFromArgv(command.split(/\s+/)) ?? null) : null,
            cwd: payload.cwd ?? process.cwd(),
            workspaceId: env.device.getCmuxWorkspaceId() ?? null,
            source: "hook",
            at: Date.now(),
        });

        logger.debug({ sessionId: payload.session_id, account }, "[claude-cmux] pinned a session");
    } catch (error) {
        logger.warn({ error }, "[claude-cmux] recording the session pin failed");
    }
}
