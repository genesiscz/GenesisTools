#!/usr/bin/env bun

import { logger } from "@genesiscz/utils/logger";
import { pollNotify } from "./notify-poll";

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
