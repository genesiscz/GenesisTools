import { isCredentialRejection, TimelyHttpError } from "@app/timely/api/errors";
import type { TimelyService } from "@app/timely/api/service";
import { suggestCommand } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";

/** Only the probe call is needed, so tests can pass a stub instead of a real service. */
type SessionProbe = Pick<TimelyService, "getAccounts">;

/**
 * Explain a failed Timely call in terms the user can act on. A 401 means four
 * different things here, so say which: an expired browser cookie, a missing
 * one, a dead OAuth login, or a plain request failure. Callers exit non-zero
 * afterwards.
 */
export async function reportTimelyFailure(err: unknown, service: SessionProbe): Promise<void> {
    if (!(err instanceof TimelyHttpError)) {
        logger.error({ error: err }, "Unexpected error talking to Timely");
        return;
    }

    if (err.scope === "token") {
        logger.error(`Timely refused to refresh your session (HTTP ${err.status}): ${err.message}`);
        logger.info(`Log in again: ${suggestCommand("tools timely", { replaceCommand: ["login", "api-key"] })}`);
        return;
    }

    if (!isCredentialRejection(err.status)) {
        logger.error(`Timely request failed (HTTP ${err.status}): ${err.message}`);
        return;
    }

    if (err.scope === "memories" && err.usedCookie) {
        logger.error(
            `Timely rejected the memories request (HTTP ${err.status}). Your stored browser session cookie has expired.`
        );
        logger.info(`Paste a fresh one: ${suggestCommand("tools timely", { replaceCommand: ["login", "cookies"] })}`);
        return;
    }

    if (err.scope === "memories" && (await sessionStillValid(service))) {
        logger.error(`Timely rejected the memories request (HTTP ${err.status}), but your API login is still valid.`);
        logger.error(
            "Memories (suggested_entries) are served by app.timelyapp.com, which accepts only a browser session cookie, not an OAuth token."
        );
        logger.info(
            `Store one: ${suggestCommand("tools timely", { replaceCommand: ["login", "cookies"] })} (or use --without-entries for events alone)`
        );
        return;
    }

    logger.error(`Timely rejected the request (HTTP ${err.status}). Your session is no longer valid.`);
    logger.info(`Log in again: ${suggestCommand("tools timely", { replaceCommand: ["login", "api-key"] })}`);
}

/**
 * Probe the OAuth API host to see whether the credentials themselves are still
 * accepted. Used only on the failure path, to pick the right remedy.
 */
async function sessionStillValid(service: SessionProbe): Promise<boolean> {
    try {
        await service.getAccounts();
        logger.debug("[failure] probe: /accounts accepted the token, so the login itself is fine");
        return true;
    } catch (probeErr) {
        logger.debug({ error: probeErr }, "[failure] probe: /accounts also rejected the token");
        return false;
    }
}
