import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import pc from "picocolors";
import { codexHooksPath, codexWiring, installCodexHooks, uninstallCodexHooks } from "../../lib/hooks/codex";
import { codexLabel, type HookInstaller, printInstallResult } from "../hooks";

/** Codex's hook file is its hooks.json. */
export const hookInstaller: HookInstaller = {
    install(options) {
        const { dist } = options;
        const result = installCodexHooks({ dist, write: Boolean(options.write) });

        ui.raw(`${pc.bold("file")}       ${codexHooksPath()}`);
        printInstallResult(result, Boolean(options.write), "the hooks file");

        if (result.changed && options.write) {
            ui.raw(
                pc.dim(
                    "Codex trusts each hook by its position and content: it asks to review a new or changed one at its next interactive start, and does not run it before that."
                )
            );
        }
    },
    uninstall: (write) => uninstallCodexHooks({ write }),
    // Codex keeps no install record.
    afterUninstall() {},
    wiring: () => codexWiring().state,
    doctor() {
        const codex = codexWiring();
        const warnings =
            codex.state !== "installed"
                ? [
                      `Codex has no ${codex.state === "stale" ? "current " : ""}shell guard of ours. Fix: ${suggestCommand("tools agents", { replaceCommand: ["hooks", "install", "--harness", "codex", "--write"] })}`,
                  ]
                : codex.trust.some((entry) => !entry.recorded)
                  ? [
                        "Codex has not trusted every hook of ours yet. It asks at its next interactive start; until then it does not run them.",
                    ]
                  : [];
        return { wiring: codexLabel(codex), warnings };
    },
};
