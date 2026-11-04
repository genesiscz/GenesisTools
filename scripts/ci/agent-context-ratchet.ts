/*
 * The files that still find the caller's agent, terminal, account or parent process themselves, counted 2026-11-04 when
 * lint-rules `no-raw-agent-env`, `no-raw-terminal-env`, `no-hardcoded-account-env`, `no-agent-binary-table` and
 * `no-parent-walk` were added (agent-context unification, spec 2026-11-04, section 5). Ratchets: no file may join a
 * list, and `lint-rules.test.ts` fails when a listed file no longer offends, so a migrated file must leave its list in
 * the same commit. The identity module (src/utils/agent/identity/) owns agent and host env, src/utils/cmux/ and
 * src/utils/tmux/ own terminal env, src/utils/ai/account-env.ts owns the account env names, and
 * src/utils/process/ owns process classification and parent walks.
 */

export const RAW_AGENT_ENV_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/claude/lib/worker/worker.ts", // CLAUDECODE, CLAUDE_CODE_SESSION_ID, until the agent-context unification (spec 2026-11-04)
    "src/utils/ai/active-processes.ts", // T3CODE_CLI_PATH, T3CODE_THREAD_ID, until the agent-context unification (spec 2026-11-04)
    "src/utils/bun/preload-test-sandbox.ts", // AI_AGENT, CLAUDECODE, CLAUDE_EFFORT (and more), until the agent-context unification (spec 2026-11-04)
    "src/utils/claude/peer-sender.ts", // CLAUDE_CODE_SESSION_ID, until the agent-context unification (spec 2026-11-04)
    "src/utils/tmux/sessions.ts", // AI_AGENT, CLAUDECODE, CLAUDE_CODE_SESSION_ID (and more), until the agent-context unification (spec 2026-11-04)
]);

export const RAW_TERMINAL_ENV_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/claude/lib/teams/ui.ts", // TMUX, until the agent-context unification (spec 2026-11-04)
    "src/say/lib/caller.ts", // CMUX_SURFACE_ID, CMUX_TAB_ID, CMUX_WORKSPACE_ID (and more), until the agent-context unification (spec 2026-11-04)
    "src/utils/bun/preload-test-sandbox.ts", // TERM_PROGRAM, TMUX, TMUX_PANE (and more), until the agent-context unification (spec 2026-11-04)
    "src/utils/bun/preload-test-tmpdir.ts", // TMUX, until the agent-context unification (spec 2026-11-04)
]);

export const HARDCODED_ACCOUNT_ENV_RATCHET: ReadonlySet<string> = new Set<string>([]);

export const AGENT_BINARY_TABLE_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/utils/cmux/tmux-host.ts", // an agent-name regex over a command line, until the agent-context unification (spec 2026-11-04)
    "src/utils/services/inventory.ts", // an agent-name regex over a command line, until the agent-context unification (spec 2026-11-04)
]);

export const PARENT_WALK_RATCHET: ReadonlySet<string> = new Set<string>([
    "src/agents/lib/hooks/diff/terminal.ts", // process.ppid, until the agent-context unification (spec 2026-11-04)
    "src/doctor/lib/processes.ts", // process.ppid, until the agent-context unification (spec 2026-11-04)
]);
