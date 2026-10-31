import { hooksConfigPath } from "@genesiscz/utils/agents/hooks/config-section";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import pc from "picocolors";
import { recordInstallState } from "../../lib/hooks/hooks-file";
import {
    claudeSettingsPath,
    hooksDistPath,
    installAndPoint,
    repoRoot,
    uninstallHooks,
    wiringStatus,
} from "../../lib/hooks/install";
import { type HookInstaller, printInstallResult } from "../hooks";
import { shortPath } from "../hooks-rules";

/** Claude's hook file is its settings.json; an install also records what it wired. */
export const hookInstaller: HookInstaller = {
    install(options) {
        const { dist } = options;
        const target = options.target ?? repoRoot();
        // The symlink is only ours to manage when it IS ours. A `--dist` pointing
        // somewhere else is the caller's path, and silently repointing it would be a
        // surprise; it is reported instead.
        const managed = dist === hooksDistPath();
        const result = installAndPoint({
            dist,
            target,
            write: Boolean(options.write),
            replaceSubagentLine: Boolean(options.replaceSubagentLine),
        });

        ui.raw(`${pc.bold("dist")}       ${dist}${managed ? ` → ${target}` : pc.dim(" (yours, not repointed)")}`);

        if (options.write) {
            // Also when nothing changed: the file then gains every setting and the record.
            recordInstallState({ dist, target: managed ? target : null });
        }

        printInstallResult(result, Boolean(options.write), "the settings file");

        if (options.write) {
            ui.raw(`${pc.bold("config")}     ${hooksConfigPath()} (every setting, plus what was installed)`);
        }
    },
    uninstall: (write) => uninstallHooks({ write }),
    afterUninstall() {
        recordInstallState({ dist: hooksDistPath(), target: null });
        ui.raw(`${pc.bold("recorded")}  ${hooksConfigPath()}`);
    },
    wiring: () => wiringStatus(),
    doctor() {
        const wired = wiringStatus();
        const state =
            wired.state === "stale"
                ? pc.yellow(`stale (${wired.events.join(", ")} differ)`)
                : wired.state === "installed"
                  ? "installed"
                  : pc.yellow("not installed");
        return {
            wiring: `${shortPath(claudeSettingsPath())}: ${state}`,
            warnings:
                wired.state === "stale"
                    ? [
                          `settings.json holds an older wiring of these hooks. Fix: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "install", "--write"] })}`,
                      ]
                    : [],
        };
    },
};
