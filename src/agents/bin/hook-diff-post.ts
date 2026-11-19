#!/usr/bin/env bun
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { fileToolSource } from "../lib/changes/log";
import { diffFor, loadHooksConfig, megabytes } from "../lib/hooks/config";
import {
    claimFileToolState,
    composePostDiff,
    noteFileToolInput,
    postRoots,
    recordFileToolChange,
} from "../lib/hooks/diff/run";
import { gitOnly } from "../lib/hooks/diff/status/modes";
import { prepareStatus, type StatusCall, statusEligible } from "../lib/hooks/diff/status/prepare";
import { sweepAbandonedCaptures } from "../lib/hooks/gc";
import { logDecision, setDiagLogPath, setMaxLogBytes } from "../lib/hooks/log";
import { isTerminalTool, normalizeEvent, parseHookPayload } from "../lib/hooks/payload";
import { rmRequestNotice } from "../lib/hooks/rm-requests";

if (env.agents.areHooksDisabled()) {
    process.exit(0);
}

const config = loadHooksConfig();

setDiagLogPath(config.logPath);
setMaxLogBytes(megabytes(config.maxLogMB));

const payload = parseHookPayload(await Bun.stdin.text());

// PostToolUseFailure is a Bash call that failed: its edits are as real as a successful one's.
if (!payload || !["posttooluse", "posttoolusefailure"].includes(normalizeEvent(payload.event))) {
    process.exit(0);
}

// Edit and Write render their own diff; they only need a row in the session change log, their file in this session's
// mention index and the cross-session touches ledger, and a claim on the state they drew, so no Bash diff repeats it.
if (fileToolSource(payload.tool)) {
    noteFileToolInput(payload);
    recordFileToolChange(payload);
    claimFileToolState({ payload, config });
    process.exit(0);
}

if (!isTerminalTool(payload.tool)) {
    process.exit(0);
}

// A background call deferred its diff to the end of its task. The ones that have ended share half
// of the one message, headings included, and this call gets the rest (`composePostDiff`).
// The status reads of this call's own diff come first and may be async; the body stays synchronous.
const diffSettings = diffFor(config, payload.harness);
// The default (Git only) reads nothing here: the body reads its roots and Git itself, as before.
const post = diffSettings.enabled && !gitOnly(diffSettings.status) ? postRoots(payload) : null;
const statusCall: StatusCall = {
    harness: payload.harness,
    sessionId: payload.sessionId ?? "",
    toolUseId: payload.toolUseId ?? "",
    command: payload.command,
    dir: payload.cwd,
};
const status =
    post && statusEligible(statusCall, { background: post.background, deferred: false })
        ? await prepareStatus({
              phase: "post",
              roots: post.roots,
              need: "all",
              call: statusCall,
              config: diffSettings.status,
          })
        : undefined;
const { flushed, decision, message } = composePostDiff({ payload, config, status });

for (const item of [...flushed, decision]) {
    logDecision(
        {
            at: new Date().toISOString(),
            phase: "post",
            harness: payload.harness,
            session: payload.sessionId,
            toolUseId: item.task?.toolUseId ?? payload.toolUseId,
            decision: item.decision,
            reason: item.reason,
            files: item.files,
            ...(item.others && item.others.length > 0 ? { others: item.others } : {}),
            ...(item.attributed ? { attributed: item.attributed } : {}),
            ...(item.declined && Object.keys(item.declined).length > 0 ? { declined: item.declined } : {}),
            ...(item.stats ? item.stats : {}),
            ...(item.task ? { background: item.task.id, flushedBy: payload.toolUseId } : {}),
        },
        config.logPath
    );
}

// A `tools rm` call whose output was cut (`>/dev/null`, `| head`) still tells the model about the request it opened.
const rmNotice = await rmRequestNotice(payload);

if ((message || rmNotice) && !config.shadow) {
    // systemMessage is the only field the USER sees; additionalContext is model-only.
    process.stdout.write(
        SafeJSON.stringify({
            ...(message ? { systemMessage: message } : {}),
            ...(rmNotice ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: rmNotice } } : {}),
        })
    );
}

// After the message: the captures of calls whose post phase never ran, at most once per ten minutes.
const swept = sweepAbandonedCaptures({ now: Date.now() });

if (swept && swept.removed.length > 0) {
    logDecision(
        {
            at: new Date().toISOString(),
            phase: "post",
            harness: payload.harness,
            session: payload.sessionId,
            decision: "swept",
            reason: "captures whose post phase never ran, or past the horizon",
            staleCaptures: swept.removed.length,
            bytes: swept.bytes,
        },
        config.logPath
    );
}
