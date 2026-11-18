import { windowsOpenCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { genesisAppBundlePath, isGenesisAppBundleInstalled } from "@genesiscz/utils/macos/genesis-app";

/** Which inbox card a banner click selects: a decision or todo (`d_…`/`t_…`) or a pending form (`ask_…`). */
export type HubItemKind = "decision" | "question";

/**
 * The shell line a banner click runs: the hub's Inbox with that card selected and scrolled to
 * (`--decision <id>` / `--question <id>`, Hub/HubWindow.swift `HubRequest`). Without an installed app
 * the caller uses its alternate delivery. The click itself checks that the hub can open.
 */
export function hubItemClickCommand(kind: HubItemKind, id: string, bundle = genesisAppBundlePath()): string | null {
    if (process.platform !== "darwin" || !isGenesisAppBundleInstalled(bundle)) {
        return null;
    }

    return windowsOpenCommand({ window: "--hub", args: ["--mode", "inbox", `--${kind}`, id] });
}
