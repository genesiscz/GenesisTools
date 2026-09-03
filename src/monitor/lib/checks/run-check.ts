import { type CheckResult, DEFAULT_TIMEOUT_MS, type Watcher } from "../types";
import { checkAiProvider } from "./ai-provider";
import { checkCommand } from "./command";
import { checkDns } from "./dns";
import { checkWebsite } from "./http";
import { checkJson } from "./json";
import { checkRss } from "./rss";
import { checkStatuspage } from "./statuspage";
import { checkTcp } from "./tcp";
import { checkTls } from "./tls";

export type CheckTarget = Pick<Watcher, "kind" | "target"> & Partial<Pick<Watcher, "config" | "timeoutMs">>;

/** One check, no persistence. The CLI `check` verb and the API `POST /check` both end here. */
export function runCheck(target: CheckTarget): Promise<CheckResult> {
    const watcher = {
        target: target.target,
        config: target.config ?? {},
        timeoutMs: target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    switch (target.kind) {
        case "website":
            return checkWebsite(watcher);
        case "statuspage":
            return checkStatuspage(watcher);
        case "ai-provider":
            return checkAiProvider(watcher);
        case "rss":
            return checkRss(watcher);
        case "tcp":
            return checkTcp(watcher);
        case "dns":
            return checkDns(watcher);
        case "tls":
            return checkTls(watcher);
        case "json":
            return checkJson(watcher);
        case "command":
            return checkCommand(watcher);
    }
}
