import type { AccountProviderAlias } from "./providers/aliases";

/**
 * Which account a LIVE agent process bills, read back off the process table.
 *
 * Nothing durable records it. A Codex rollout's `session_meta` payload and all 39 columns of
 * its `threads` row are account-blind (checked against `~/.codex` on 2026-09-11), a Claude
 * transcript is the same, and the history index has no account column either. The launcher's
 * environment is the only truthful answer to "which account does this pane bill", which is why
 * every launcher exports one of these and every reader comes through here.
 *
 * The name is derived from the provider alias rather than listed, so a fourth provider cannot
 * be half-wired: `TOOLS_CLAUDE_ACCOUNT`, `TOOLS_CODEX_ACCOUNT`, `TOOLS_GROK_ACCOUNT`.
 */
export function accountEnvVar(alias: AccountProviderAlias): string {
    return `TOOLS_${alias.toUpperCase()}_ACCOUNT`;
}

export interface LiveAccount {
    /** The account name, or null when the process was launched outside `tools <tool> run`. */
    account: string | null;
    /** Set INSTEAD of `account` when the launcher pointed the process at the ai-proxy. */
    proxyTarget: string | null;
}

const NONE: LiveAccount = { account: null, proxyTarget: null };

/**
 * One environment value out of a `ps` args-plus-environment line.
 *
 * `ps axeww` and `ps eww` print the argv FIRST, then append the environment after it as bare
 * `KEY=VALUE` words. Measured 2026-09-14 against a live line (`bun …/tools artifact serve .
 * --port 3077 PNPM_HOME=… PHP_INI_SCAN_DIR=…`), and `parsePinnedProcesses` in
 * `src/claude/lib/doctor.ts` records the same order. Nothing quotes a value, so one value ends
 * where the next `KEY=` word starts, or at the end of the line.
 *
 * That order is what lets a value hold a space. The earlier reader stopped at the first
 * whitespace, so the account `work laptop` was reported as the DIFFERENT account `work`.
 *
 * The key is matched at a word boundary, so `TOOLS_CLAUDE_ACCOUNT` never takes the value of
 * `TOOLS_CLAUDE_ACCOUNT_FILE`, and it is escaped before it reaches `RegExp`, because
 * `readProcessEnvKeys` takes an arbitrary key list.
 *
 * ⚠️ KNOWN LIMIT: a value that itself contains a ` WORD=` fragment is truncated at it, so
 * `K=a b=c` reads back as `a`. Nothing in `ps` output quotes a value, so those bytes are
 * identical to `K=a` followed by the variable `b`, and no reader can tell the two apart. It does
 * not affect an account name; it does affect keys like `npm_lifecycle_script` and `EDITOR`.
 *
 * 🛑 The `m` flag is load-bearing, not tidiness. Without it `$` matches only the end of the
 * WHOLE string, and `.` never crosses a newline, so a lazy capture could never reach it: a key
 * that was the LAST `KEY=` word of a line returned `undefined`. `readProcessEnvKeys` always
 * passes the entire `ps eww -p <pid>` stdout, which always ends in a newline, and the codex and
 * grok launchers put their account variable last.
 */
export function psEnvValue(psLine: string, key: string): string | undefined {
    // `readProcessEnvKeys(pid, keys)` takes its key list from the caller, so the key is not
    // guaranteed to be a plain identifier. Unescaped, a `.` matched any character and a `(`
    // threw a SyntaxError out of a reader whose whole contract is "answer or undefined".
    const literal = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = psLine.match(new RegExp(`(?:^|\\s)${literal}=(.*?)(?=\\s+[A-Za-z_][A-Za-z0-9_]*=|$)`, "m"));

    if (!match) {
        return undefined;
    }

    // An exported-but-empty variable is not an answer; every caller reads undefined as "unknown".
    return match[1].trimEnd() || undefined;
}

/** Read one provider's account out of a `ps` args-plus-environment line. */
export function accountFromEnv(envArgs: string, alias: AccountProviderAlias): LiveAccount {
    const value = psEnvValue(envArgs, accountEnvVar(alias));

    if (value === undefined) {
        return NONE;
    }

    if (value.startsWith("proxy:")) {
        return { account: null, proxyTarget: value.slice("proxy:".length) };
    }

    return { account: value, proxyTarget: null };
}
