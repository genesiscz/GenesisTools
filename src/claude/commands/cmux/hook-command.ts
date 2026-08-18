import { HOOK_COMMAND, hookState, installHook, removeHook, settingsPath } from "@app/claude/lib/cmux/hook";
import { loadPins } from "@app/claude/lib/cmux/pins";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

export type HookAction = "status" | "install" | "remove";

/**
 * Manage the SessionStart hook that records which account each session ran as.
 * Without it every restored pane has to ask, so `status` also reports how many
 * pins have actually been collected — an installed hook that never fired is a
 * silent failure worth seeing.
 */
export async function hookCommand(action: HookAction = "status"): Promise<void> {
    if (action === "install") {
        const result = await installHook();

        if (!result.changed) {
            out.printlnErr(`${pc.green("✔")} Already installed in ${pc.dim(settingsPath())}`);
            return;
        }

        out.printlnErr(`${pc.green("✔")} Installed the SessionStart hook in ${pc.dim(settingsPath())}`);

        if (result.backup) {
            out.printlnErr(pc.dim(`  Previous settings backed up to ${result.backup}`));
        }

        out.printlnErr(pc.dim("  It applies to sessions started from now on."));
        return;
    }

    if (action === "remove") {
        const result = await removeHook();
        out.printlnErr(
            result.changed
                ? `${pc.green("✔")} Removed the hook from ${pc.dim(settingsPath())}`
                : pc.yellow("The hook was not installed.")
        );

        if (result.backup) {
            out.printlnErr(pc.dim(`  Previous settings backed up to ${result.backup}`));
        }

        return;
    }

    const state = await hookState();
    const pins = await loadPins();

    out.printlnErr(
        state === "installed"
            ? `${pc.green("●")} Installed — ${pc.dim(HOOK_COMMAND)}`
            : `${pc.yellow("○")} Not installed — ${pc.dim(`add it with: tools claude cmux hook install`)}`
    );
    out.printlnErr(pc.dim(`  Settings: ${settingsPath()}`));
    out.printlnErr(pc.dim(`  Pinned sessions recorded: ${pins.size}`));
}
