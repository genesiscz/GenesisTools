import { nativeSessionRoots } from "@genesiscz/utils/providers/session-paths";
import type { AccountEntry } from "../../../config/schema";
import type { SpendScope } from "../../account-features";

/**
 * Where an Anthropic account's Claude Code transcripts live.
 *
 * Every account gets the SAME tree: `~/.claude/projects` (plus the
 * `~/.config/claude` and `CLAUDE_CONFIG_DIR` variants) carries no marker saying
 * which login wrote a session, so the scope cannot be narrowed per account.
 * Campaign decision D6 follows from that — the transcript spend reports one
 * "claude (all accounts)" row, and per-account Claude numbers come from the call
 * log, which IS keyed by account id at write time.
 *
 * The caller must therefore emit these roots ONCE, untagged, rather than once
 * per account, or the same bytes get counted as many times as there are logins.
 */
export function anthropicSpendScope(_account: AccountEntry): SpendScope {
    return { source: "claude", transcriptRoots: nativeSessionRoots("claude") };
}
