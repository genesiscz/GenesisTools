import { existsSync, statSync } from "node:fs";
import { browserVersion } from "@app/chrome-devtools/lib/cdp";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { BROWSER_DEVTOOLS_PORT } from "@genesiscz/utils/net/ports";
import { WazeClient } from "./client";
import { BrowserTabTransport, LIVE_MAP_URL } from "./session";
import { wazeDbPath } from "./store";

const { log } = logger.scoped("waze-doctor");

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    detail: string;
    fix?: string;
}

/** A small box over central Prague: enough reports to prove the feed answers, well under the item cap. */
const PROBE_BOX = { top: 50.09, bottom: 50.07, left: 14.4, right: 14.44 };

/**
 * Read-only health check: the browser port, the live-map tab, one token mint and one georss call. It writes nothing
 * durable: a kept tab stays kept, a temporary tab is closed, the store is only stat'ed (never migrated).
 */
export async function runDoctor(opts: { port?: number } = {}): Promise<DoctorCheck[]> {
    const port = opts.port ?? BROWSER_DEVTOOLS_PORT;
    const checks: DoctorCheck[] = [];
    const version = await browserVersion(port, { signal: AbortSignal.timeout(3000) });
    if (version === null) {
        checks.push({
            name: "browser",
            status: "fail",
            detail: `nothing answers CDP on 127.0.0.1:${port}`,
            fix: toolCommand("chrome-devtools restart", "--browser", "brave", "--port", String(port)),
        });
        checks.push({ name: "live map tab", status: "skip", detail: "needs the browser" });
        return [...checks, storeCheck()];
    }

    checks.push({ name: "browser", status: "ok", detail: `${version} on port ${port}` });
    let transport: BrowserTabTransport | undefined;
    try {
        const started = performance.now();
        // keepTab: a tab kept by an earlier run stays open; persistKeptTab: false never writes the kept-tab file.
        transport = await BrowserTabTransport.open({ port, keepTab: true, persistKeptTab: false });
        const info = transport.info();
        checks.push({
            name: "live map tab",
            status: "ok",
            detail: `${info.reused ? "reused the kept tab" : "opened a temporary background tab"} ${info.tabId.slice(0, 8)}, reCAPTCHA ready in ${Math.round(performance.now() - started)} ms`,
        });
        checks.push(
            info.userReportsHidden === true
                ? {
                      name: "user reports",
                      status: "warn",
                      detail: "the live map's config sets hideUserReportsAndWazers: georss answers road closures only, no police, accidents or hazards",
                  }
                : {
                      name: "user reports",
                      status: info.userReportsHidden === false ? "ok" : "warn",
                      detail:
                          info.userReportsHidden === false
                              ? "the live map shows user reports"
                              : "the page config has no hideUserReportsAndWazers flag; Waze changed the page",
                  }
        );
        const token = await transport.mintToken();
        checks.push({
            name: "token mint",
            status: token.length > 0 ? "ok" : "fail",
            detail: token.length > 0 ? `${token.length} chars in ${token.ms} ms` : "grecaptcha returned no token",
        });
        const client = new WazeClient(transport);
        const georssStarted = performance.now();
        const answer = await client.georss(PROBE_BOX, ["alerts", "traffic"]);
        checks.push({
            name: "georss",
            status: "ok",
            detail: `${answer.alerts.length} alerts, ${answer.jams.length} jams for central Prague in ${Math.round(performance.now() - georssStarted)} ms`,
        });
    } catch (error) {
        log.debug({ error }, "waze doctor check failed");
        checks.push({
            name: transport ? "georss" : "live map tab",
            status: "fail",
            detail: error instanceof Error ? error.message : String(error),
            fix: transport ? undefined : `open ${LIVE_MAP_URL} in the browser once and accept any consent`,
        });
    } finally {
        if (transport) {
            await transport.close({ persist: transport.info().reused });
        }
    }

    return [...checks, storeCheck()];
}

function storeCheck(): DoctorCheck {
    const path = wazeDbPath();
    if (!existsSync(path)) {
        return {
            name: "history store",
            status: "skip",
            detail: `${path} not created yet (the record command creates it)`,
        };
    }

    return { name: "history store", status: "ok", detail: `${path} (${Math.round(statSync(path).size / 1024)} KB)` };
}
