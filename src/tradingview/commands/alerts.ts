import { logger, out } from "@app/logger";
import pc from "picocolors";
import { AlertsFeed } from "../lib/alerts-feed";
import { listAlerts } from "../lib/alerts-rest";
import { resolveSession } from "../lib/auth";
import { formatAlertFire, formatAlertRow } from "../lib/format";
import { parseProSymbol } from "../lib/symbols";

interface AlertsOpts {
    cookie?: string;
    listOnly?: boolean;
}

export async function runAlerts(opts: AlertsOpts): Promise<void> {
    const session = await resolveSession({ cookie: opts.cookie });
    if (!session) {
        out.error(
            "No TradingView session found. Set TRADINGVIEW_COOKIE (or TRADINGVIEW_SESSIONID + " +
                "TRADINGVIEW_SESSIONID_SIGN + TRADINGVIEW_USERNAME + TRADINGVIEW_USER_ID), or run `tools tradingview login`."
        );
        process.exit(1);
    }

    const alerts = await listAlerts(session);
    out.printlnErr(pc.bold(`\n${alerts.length} alert(s):\n`));
    for (const alert of alerts) {
        out.printlnErr(formatAlertRow(alert));
    }

    if (opts.listOnly) {
        return;
    }

    out.printErr(pc.dim("\nListening for live alert fires — Ctrl-C to stop\n"));
    const feed = new AlertsFeed(session);
    feed.on("fired", (fire) => out.printlnErr(formatAlertFire(fire)));
    feed.on("created", (created) => {
        for (const a of created) {
            out.printlnErr(pc.green(`+ created ${parseProSymbol(a.symbol)} — ${a.message}`));
        }
    });
    feed.on("updated", (updated) => {
        for (const a of updated) {
            const reason = a.last_stop_reason ? pc.dim(` (${a.last_stop_reason})`) : "";
            out.printlnErr(
                pc.cyan(`~ updated ${parseProSymbol(a.symbol)} — ${a.active ? "active" : "inactive"}${reason}`),
            );
        }
    });
    feed.on("error", (err) => logger.error({ err }, "tradingview: alerts feed error"));
    feed.on("close", () => out.printErr(pc.dim("\nFeed closed.")));

    process.on("SIGINT", () => {
        feed.close();
        process.exit(0);
    });

    feed.connect();
    await new Promise(() => {});
}
