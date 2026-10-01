import { existsSync } from "node:fs";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { escapeShellArg } from "@genesiscz/utils/string";

/** Which inbox card a banner click selects: a decision or todo (`d_…`/`t_…`) or a pending form (`ask_…`). */
export type HubItemKind = "decision" | "question";

/**
 * The shell line a banner click runs: the hub's Inbox with that card selected and scrolled to
 * (`--decision <id>` / `--question <id>`, Hub/HubWindow.swift `HubRequest`). `open -n` hands the flags
 * to a running hub. Null when GenesisTools.app is not installed, so the caller sends no hub banner.
 */
export function hubItemClickCommand(kind: HubItemKind, id: string, bundle = genesisAppBundlePath()): string | null {
    if (process.platform !== "darwin" || !existsSync(bundle)) {
        return null;
    }

    return ["/usr/bin/open", "-n", bundle, "--args", "--hub", "--mode", "inbox", `--${kind}`, id]
        .map(escapeShellArg)
        .join(" ");
}
