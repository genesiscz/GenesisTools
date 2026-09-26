#!/usr/bin/env bun

import { logger } from "@genesiscz/utils/logger";
import { pollNotify } from "./notify-poll";
import { runRules } from "./rules";

// The `hub-pr-notify` daemon task (`tools hub notify install`): one poll, then exit. The poll skips
// a run that is not due yet, so the task's cadence and the configured interval may differ safely.

const log = logger.child({ component: "hub/notify-daemon" });

try {
    const report = await pollNotify();
    log.info(
        { skipped: report.skipped, items: report.items.length, posted: report.posted, requests: report.requests },
        "notify daemon run"
    );
} catch (err) {
    log.error({ err }, "notify daemon run failed");
    process.exitCode = 1;
}

// The notification rules (`tools hub rules`) ride the same tick: no timer of their own, and they work
// while the hub is closed. After the poll, so a CI failure it just posted suppresses the rule's banner.
try {
    const rules = await runRules();
    log.info({ skipped: rules.skipped, firings: rules.firings.length, posted: rules.posted }, "hub rules run");
} catch (err) {
    log.error({ err }, "hub rules run failed");
    process.exitCode = 1;
}
