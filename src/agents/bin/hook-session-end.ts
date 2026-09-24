#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { loadHooksConfig } from "../lib/hooks/config";
import { collectStaleCaptures } from "../lib/hooks/gc";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { parseHookPayload } from "../lib/hooks/payload";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(config.maxLogBytes);

const payload = parseHookPayload(await Bun.stdin.text());

if (!payload) {
    process.exit(0);
}

// This session's captures first, because the session is over and age cannot gate them.
// Then the age horizon, which catches every session that ended without a SessionEnd.
const mine = payload.sessionId
    ? collectStaleCaptures({ now: Date.now(), sessionId: payload.sessionId, write: true })
    : { removed: [], kept: 0, bytes: 0, write: true };
const stale = collectStaleCaptures({ now: Date.now(), write: true });

logDecision(
    {
        at: new Date().toISOString(),
        phase: "post",
        harness: payload.harness,
        session: payload.sessionId,
        decision: "swept",
        reason: "session ended",
        sessionCaptures: mine.removed.length,
        staleCaptures: stale.removed.length,
        bytes: mine.bytes + stale.bytes,
    },
    config.logPath
);
