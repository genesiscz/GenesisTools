import { loadPins, pinsPath } from "@app/claude/lib/cmux/pins";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/** Rows shown by default; the journal holds every session ever launched. */
const DEFAULT_ROWS = 15;

export interface PinsOptions {
    limit: string;
}

/**
 * Show the account pins collected so far.
 *
 * The pins come from the `record-session-account` SessionStart hook that ships with the
 * genesis-tools PLUGIN, so an empty journal is a plugin problem, not a config one — which
 * is what the footer says when there is nothing to show.
 */
export async function pinsCommand(opts: PinsOptions): Promise<void> {
    const pins = await loadPins();
    const limit = Number.parseInt(opts.limit, 10) || DEFAULT_ROWS;

    if (pins.size === 0) {
        out.printlnErr(pc.yellow("No session pins recorded yet."));
        out.printlnErr(pc.dim(`  Journal: ${pinsPath()}`));
        out.printlnErr(
            pc.dim(
                "  Pins are written by the genesis-tools plugin's SessionStart hook.\n" +
                    "  If it is installed, only sessions started AFTER it landed have pins;\n" +
                    "  plugin edits need a push plus /plugin update before they take effect."
            )
        );
        return;
    }

    const recent = [...pins.values()].sort((a, b) => b.at - a.at).slice(0, limit);
    renderCliHeader("Claude session pins", "which account each session ran as");

    const table = createBoxTable(["SESSION", "ACCOUNT", "MODEL", "RECORDED", "CWD"]);

    for (const pin of recent) {
        table.push([
            pc.cyan(pin.sessionId.slice(0, 8)),
            pin.account ? pc.magenta(pin.account) : pc.dim("keychain"),
            pin.model ? pc.white(pin.model) : pc.dim("—"),
            pc.dim(new Date(pin.at).toISOString().replace("T", " ").slice(0, 16)),
            truncateDisplay(pin.cwd, 44),
        ]);
    }

    out.println(table.toString());
    out.printlnErr(pc.dim(`${pins.size} pinned session${pins.size === 1 ? "" : "s"} · ${pinsPath()}`));
}
