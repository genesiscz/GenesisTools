import type { AppStatus } from "@app/macos/lib/permissions/app";

export type GenesisAppRefreshAction = "skip" | "rebuild";

/**
 * #445: building GenesisTools.app is opt-in in `install.sh` now, so `tools update` must never
 * install it for someone who never asked for it. It only keeps an EXISTING install current:
 * a built app whose sources changed gets rebuilt, everything else is left alone.
 */
export function genesisAppRefreshAction(status: Pick<AppStatus, "built" | "stale">): GenesisAppRefreshAction {
    if (!status.built) {
        return "skip";
    }

    return status.stale ? "rebuild" : "skip";
}
