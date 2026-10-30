import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";

/** What a Grok worker (`tools <agent> run --worker`, the driver in its tool) can do. Moved from WORKER_CAPABILITIES. */
export const grokWorker: WorkerCapabilities = {
    approvals: "none",
    sandbox: "cwd-jail",
    readonlyMode: true,
    structuredOutput: ["streaming-json (flat NDJSON)"],
    steering: "between-turns",
    accountRequired: false,
    accountUnsupported:
        "grok pins an auth FILE, not an account, so the flag would silently do nothing. Pass --auth subscription and point GROK_AUTH_PATH at that account's auth.json (references/grok.md).",
    busMail: "login-once",
    // The cwd jail leaves watchman's state directory writable.
    sandboxBlocksWatchman: false,
    verbs: ["spawn", "steer", "read", "tail", "status", "stop", "interrupt", "sessions"],
    absentVerbs: {
        approve: "grok has no approval channel (approvals: none) — the cwd jail and the brief are the only brakes",
        deny: "grok has no approval channel (approvals: none)",
    },
};
