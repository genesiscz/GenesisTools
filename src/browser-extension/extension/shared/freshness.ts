import type { Freshness } from "@genesiscz/utils/browser-extension/runtime/freshness";
import { ext } from "../chrome";

export { type Freshness, freshnessFromReply } from "@genesiscz/utils/browser-extension/runtime/freshness";

const TITLES: Record<Freshness, string> = {
    current: "GenesisTools",
    reload: "GenesisTools: a newer build is ready. Open this popup and click Reload.",
    rebuild: "GenesisTools: the extension needs a rebuild. Open this popup and click Rebuild.",
    unknown: "GenesisTools",
};

/** The toolbar icon says it: a `!` badge and a title that names the fix. */
export async function showFreshness(state: Freshness): Promise<void> {
    const stale = state === "reload" || state === "rebuild";
    await ext.action.setBadgeText({ text: stale ? "!" : "" });

    if (stale) {
        await ext.action.setBadgeBackgroundColor({ color: "#d97706" });
    }

    await ext.action.setTitle({ title: TITLES[state] });
}
