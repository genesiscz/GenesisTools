import { type CheckResult, DEFAULT_TIMEOUT_MS, type Watcher } from "../types";
import { checkAiProvider } from "./ai-provider";
import { checkWebsite } from "./http";
import { checkRss } from "./rss";
import { checkStatuspage } from "./statuspage";

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
    }
}
