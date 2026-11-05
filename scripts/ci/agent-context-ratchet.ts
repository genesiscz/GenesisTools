/*
 * The files that still find the caller's agent, terminal, account or parent process themselves, counted 2026-11-04 when
 * lint-rules `no-raw-agent-env`, `no-raw-terminal-env`, `no-hardcoded-account-env`, `no-agent-binary-table` and
 * `no-parent-walk` were added (agent-context unification, spec 2026-11-04, section 5). Ratchets: no file may join a
 * list, and `lint-rules.test.ts` fails when a listed file no longer offends, so a migrated file must leave its list in
 * the same commit. The identity module (src/utils/agent/identity/) owns agent and host env, src/utils/cmux/ and
 * src/utils/tmux/ own terminal env, src/utils/ai/account-env.ts owns the account env names, and
 * src/utils/process/ owns process classification and parent walks. Each entry names its next step (W4 completeness
 * review, 2026-11-05); the files that only remove keys from an env they hand on are allowed in lint-rules
 * (`AGENT_ENV_SCRUBBERS`), not listed here.
 */

export const RAW_AGENT_ENV_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/utils/ai/active-processes.ts", // T3CODE_CLI_PATH, T3CODE_THREAD_ID: move AGENT_HOST_MARKERS into src/utils/t3code
    "src/utils/claude/peer-sender.ts", // CLAUDE_CODE_SESSION_ID: take the session from whoIsCallingHere(), keep the socket and pid reads
]);

export const RAW_TERMINAL_ENV_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const HARDCODED_ACCOUNT_ENV_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const AGENT_BINARY_TABLE_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/utils/cmux/tmux-host.ts", // an agent-name regex over a command line: classify it with classifyCommand (src/utils/process/classify.ts)
    "src/utils/services/inventory.ts", // an agent-name regex over a command line: classify it with classifyCommand (src/utils/process/classify.ts)
]);

export const PARENT_WALK_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/agents/lib/hooks/diff/terminal.ts", // process.ppid: walk the parents through src/utils/process
    "src/doctor/lib/processes.ts", // process.ppid: walk the parents through src/utils/process
]);
