import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AuthVerdict, readAuthHealth, type TeamsAuthHealth } from "@app/ms-teams/lib/auth-health";
import { liveWebLogRoot } from "@app/ms-teams/lib/paths";
import { suggestCommand } from "@genesiscz/utils/cli";
import { formatClock } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";

const log = logger.scoped("ms-teams").log;

const VERDICT_TEXT: Record<AuthVerdict, { status: "ok" | "warn" | "err" | "dim"; text: string }> = {
    healthy: { status: "ok", text: "Every chat token renews, and the chat list loads." },
    "needs-sign-in": {
        status: "err",
        text: "Teams cannot renew a chat token silently: Entra ID wants an interactive sign-in. A restart and `repair idb` do not fix this. Sign in again inside the Teams app (the browser can be blocked by the organization's access policy).",
    },
    "chat-errors": {
        status: "warn",
        text: "The chat tokens renew, but the chat-list query fails. This is not a sign-in problem: check the live store with `repair probe`, then consider `repair idb`.",
    },
    "other-sign-in": {
        status: "warn",
        text: "The chat tokens renew. Another resource wants a sign-in, so only that feature is affected.",
    },
    "no-chat-renew": {
        status: "dim",
        text: "The log holds no completed chat-token renew yet, so it cannot tell whether the chat tokens renew. Keep Teams open for about an hour, then run this again.",
    },
    "no-log": {
        status: "dim",
        text: "No web-client log was found. Start Teams and wait a minute, then run this again.",
    },
};

export function registerAuthCommand(program: Command): void {
    program
        .command("auth")
        .description(
            "Read-only: do the Teams sign-in tokens renew, and does the chat list load? Reads the web-client log"
        )
        .option("--all", "list every token resource, not only the chat ones and the failing ones")
        .option("--copy-to <dir>", "first copy the web-client log there; Teams deletes it within one to two hours")
        .option("--json", "Machine-readable JSON")
        .action((opts: { all?: boolean; copyTo?: string; json?: boolean }) => {
            const root = liveWebLogRoot();

            if (opts.copyTo) {
                const target = join(resolve(opts.copyTo), `teams-web-log-${Date.now()}`);
                cpSync(root, target, { recursive: true });
                log.debug({ root, target }, "[ms-teams] copied the web-client log");
                out.log.info(`Copied the web-client log to ${target}`);
            }

            const health = readAuthHealth(root);

            if (opts.json) {
                out.result(health);
                return;
            }

            renderAuthHealth(health, Boolean(opts.all));
        });
}

function renderAuthHealth(health: TeamsAuthHealth, all: boolean): void {
    renderCliHeader("Teams sign-in", "reads the web-client log, does not write");

    if (health.windowStart !== null && health.windowEnd !== null) {
        out.println(
            `Log covers ${formatClock(health.windowStart, { seconds: true })} to ${formatClock(health.windowEnd, { seconds: true })} (${health.files} files). Teams deletes older parts.`
        );
    }

    const rows = health.resources.filter((r) => all || r.chatCritical || r.failures > 0);

    if (rows.length > 0) {
        const table = createBoxTable(["RESOURCE", "USED FOR", "RENEWS", "LAST OK", "LAST FAILURE", "ERRORS"]);

        for (const r of rows) {
            table.push([
                truncateDisplay(r.resource, 44),
                truncateDisplay(r.label ?? "", 34),
                r.needsSignIn
                    ? formatDotStatus("err", "needs sign-in")
                    : r.lastFailureAt !== null && r.lastFailureAt > (r.lastSuccessAt ?? 0)
                      ? formatDotStatus("warn", "failing")
                      : formatDotStatus("ok", `${r.successes} ok`),
                r.lastSuccessAt === null ? "" : formatClock(r.lastSuccessAt, { seconds: true }),
                r.lastFailureAt === null ? "" : formatClock(r.lastFailureAt, { seconds: true }),
                truncateDisplay(r.errors.join(", "), 40),
            ]);
        }

        out.println(table.toString());
    }

    const chatList = health.graphql.filter((g) => /LeftRail/i.test(g.operation));

    for (const g of chatList) {
        out.println(
            `Chat-list query ${g.operation} failed ${g.count}x, last at ${formatClock(g.lastAt, { seconds: true })}.`
        );
    }

    for (const r of health.reducedCapabilities) {
        out.println(
            `Teams reported REDUCED_CAPABILITIES_${r.name}, last at ${formatClock(r.lastAt, { seconds: true })}.`
        );
    }

    const verdict = VERDICT_TEXT[health.verdict];
    out.println("");
    out.println(formatDotStatus(verdict.status, verdict.text));

    if (health.verdict === "needs-sign-in") {
        out.println(suggestCommand("tools ms-teams", { replaceCommand: ["auth", "--copy-to", "<dir>"] }));
    }
}
