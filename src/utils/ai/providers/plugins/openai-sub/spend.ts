import { dirname } from "node:path";
import { nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import type { AccountEntry } from "../../../config/schema";
import type { SpendScope } from "../../account-features";

/**
 * The Codex home this account logs in through: the directory holding its
 * `auth.json`, or an explicit `dataDir`. Codex keeps one profile per home
 * (`~/.codex`, `~/.codex-work`), so the home IS the account boundary — unlike
 * Anthropic, whose accounts all share one tree.
 */
export function codexHomeOf(account: AccountEntry): string | undefined {
    const authFile = account.credentials.authFile;

    if (authFile) {
        return dirname(authFile);
    }

    return account.credentials.dataDir;
}

/**
 * `sessions` and `archived_sessions` of that home.
 *
 * `nativeSessionRootsForHome` is used rather than `nativeSessionRoots` on
 * purpose: the latter folds in `CODEX_HOME`, which would attribute whichever
 * home the shell happens to point at to this account.
 */
export function codexSpendScope(account: AccountEntry): SpendScope | undefined {
    const home = codexHomeOf(account);

    if (!home) {
        return undefined;
    }

    return { source: "codex", transcriptRoots: nativeSessionRootsForHome("codex", home) };
}
