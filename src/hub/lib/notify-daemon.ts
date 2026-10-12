#!/usr/bin/env bun

import { logger } from "@genesiscz/utils/logger";
import { NOT_DUE, pollNotify } from "./notify-poll";
import { runRules } from "./rules";

// The `hub-pr-notify` daemon task (`tools hub notify install`): one tick a minute, one poll, then exit. The poll
// fetches only the repos whose own cadence has come, so most ticks end after reading two small JSON files.

const log = logger.child({ component: "hub/notify-daemon" });

let notDue = false;

try {
    const report = await pollNotify();
    notDue = report.skipped?.startsWith(NOT_DUE) ?? false;
    log.info(
        { skipped: report.skipped, items: report.items.length, posted: report.posted, requests: report.requests },
        "notify daemon run"
    );
} catch (err) {
    log.error({ err }, "notify daemon run failed");
    process.exitCode = 1;
}

// The notification rules (`tools hub rules`) ride the ticks that polled: no timer of their own, and they work
// while the hub is closed. After the poll, so a CI failure it just posted suppresses the rule's banner. A tick where
// no repo was due skips them too, so they keep the cadence they had before the task ticked every minute.
if (!notDue) {
    try {
        const rules = await runRules();
        log.info({ skipped: rules.skipped, firings: rules.firings.length, posted: rules.posted }, "hub rules run");
    } catch (err) {
        log.error({ err }, "hub rules run failed");
        process.exitCode = 1;
    }
}
