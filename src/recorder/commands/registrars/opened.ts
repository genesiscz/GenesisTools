import { readEditorOpenState, waitForEditorOpen } from "@app/recorder/lib/library";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("opened")
        .description("The recordings open in the editor and the one in front; `open` names it in every other command")
        .option("--wait [seconds]", "wait until the editor brings a recording to the front, then print it", "")
        .option("--json", "print as JSON")
        .action(async (flags: { wait: string | boolean; json?: boolean }) => {
            if (flags.wait !== "") {
                const seconds = typeof flags.wait === "string" ? Number(flags.wait) : 600;
                const front = await waitForEditorOpen({ timeoutMs: (Number.isFinite(seconds) ? seconds : 600) * 1000 });
                out.result(flags.json ? front : front.path);
                return;
            }

            const state = readEditorOpenState();

            if (flags.json) {
                out.result(state ?? { open: [] });
                return;
            }

            if (!state?.open.length) {
                out.printlnErr(`No recording is open in the editor. Pick one: ${toolCommand("recorder library")}`);
                return;
            }

            for (const row of state.open) {
                out.println(`${row.path === state.front?.path ? "▶" : " "} ${row.title}  ${row.path}`);
            }
        });
}
