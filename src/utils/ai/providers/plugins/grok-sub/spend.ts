import { dirname, resolve } from "node:path";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import type { AccountEntry } from "../../../config/schema";
import { grokAuthPath } from "../../../grok/paths";
import type { SpendScope } from "../../account-features";
import { workerHomesIn } from "./discover";

export interface GrokSpendScopeOptions {
    /** Where harness worker homes live. Injected by tests; defaults to `~/.genesis-tools/grok`. */
    workerRoot?: string;
    /** The default login's auth file. Injected by tests; defaults to `$GROK_HOME/auth.json`. */
    defaultAuthFile?: string;
}

/** The grok home this account logs in through. */
function grokHomeOf(account: AccountEntry): string | undefined {
    const authFile = account.credentials.authFile;

    if (authFile) {
        return dirname(authFile);
    }

    return account.credentials.dataDir;
}

/**
 * Where a SuperGrok account's Grok CLI transcripts live.
 *
 * Two trees, not one. The obvious `<home>/sessions`, plus every
 * `~/.genesis-tools/grok/worker-home*` when this account owns the DEFAULT login:
 * `tools grok run` pins the worker to an isolated `GROK_HOME` for isolation, but
 * authenticates it with `GROK_AUTH_PATH` pointing at that default `auth.json`.
 * The worker's turns are therefore billed to this account, and they are never
 * written to the call log (worker turns emit no per-turn call event), so if the
 * transcript store misses them the spend is invisible everywhere.
 *
 * `nativeSessionRoots("grok")` appends only `worker-home` itself, so the glob
 * here is what reaches `worker-home-2`, `worker-home-a58d…` and the rest.
 */
export function grokSpendScope(account: AccountEntry, options: GrokSpendScopeOptions = {}): SpendScope | undefined {
    const home = grokHomeOf(account);

    if (!home) {
        return undefined;
    }

    const transcriptRoots = nativeSessionRootsForHome("grok", home);
    const authFile = account.credentials.authFile;
    const defaultAuthFile = options.defaultAuthFile ?? grokAuthPath();

    if (authFile && resolve(authFile) === resolve(defaultAuthFile)) {
        for (const workerHome of workerHomesIn(options.workerRoot ?? grokRoot())) {
            for (const root of nativeSessionRootsForHome("grok", workerHome)) {
                if (!transcriptRoots.includes(root)) {
                    transcriptRoots.push(root);
                }
            }
        }
    }

    return { source: "grok", transcriptRoots };
}
