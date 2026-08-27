import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { rememberLastPort } from "../lib/paths.ts";
import { CDP_PORTS, isPortSpecified, planAttach, renderAttachPlan } from "../lib/resolve-attach.ts";
import {
    guidanceBlock,
    portOf,
    scanInventory,
    startRecorderBackground,
    suggest,
    TOOL_CMD,
    withPort,
} from "./shared.ts";

/**
 * Auto-record on attach. Benchmarked on the real browser before shipping
 * (see README "Benchmark"); if that ever regresses, flip this to false and
 * attach degrades to guidance-only, never silently.
 */
const ATTACH_AUTO_RECORD = true;

export function registerAttach(program: Command): void {
    withPort(program.command("attach"))
        .description(
            "scan the 9222-9230 range PLUS every listening Chromium debug port (lsof, DevToolsActivePort files), list every CDP endpoint, start the background recorder, and print what to do next. Errors when two Chromium browsers are open and no --port picks one."
        )
        .addHelpText(
            "after",
            `
The debugging flag is read at browser STARTUP — it cannot be enabled on a
running browser. When nothing listens, attach prints the exact restart/open
commands. Ask the user before quitting their browser (open tabs are at stake).`
        )
        .action(async (opts: { port?: string }) => {
            const inventory = await scanInventory();
            const explicitPort = isPortSpecified() ? portOf(opts) : undefined;
            const plan = planAttach(inventory, { explicitPort });

            if (plan.status === "none" && plan.running.length === 0) {
                out.log.error(`No CDP endpoint on ${CDP_PORTS.join(", ")}.

A browser must be LAUNCHED with the flag — it cannot be enabled at runtime.
  Reuse your real profile (keeps logins, costs open tabs):
    ${suggest(["restart", "--browser", "brave", "--port", "9222"])}
  Or a throwaway profile alongside it (nothing of yours touched):
    ${suggest(["open", "--browser", "chrome", "--port", "9223", "--fresh", "https://example.com"])}`);
                process.exit(1);
            }

            const { text, exitCode } = renderAttachPlan(plan, { cmd: TOOL_CMD, suggestCommand: suggest });
            out.println(text);

            if (plan.status === "list") {
                // Remember the endpoint this attach settled on, so the very next
                // `nav`/`eval`/`targets` needs no --port. Only meaningful when
                // ONE endpoint is in play; with several, --port stays mandatory.
                if (plan.endpoints.length === 1) {
                    rememberLastPort(plan.endpoints[0].port);
                }

                for (const e of plan.endpoints) {
                    let recording = false;
                    if (ATTACH_AUTO_RECORD) {
                        const r = startRecorderBackground(e.port);
                        recording = true;
                        if (r.started) {
                            out.log.info(
                                `recorder started on ${e.port} (pid ${r.pid}, one per port, dies when CDP drops)`
                            );
                        }
                    }

                    out.println("");
                    out.println(guidanceBlock(e.port, recording));
                }

                if (plan.endpoints.length > 1) {
                    out.println(`
Two endpoints live. Compare broken vs working:
    ${suggest(["cookies", "--port", String(plan.endpoints[0].port), "--json"])} > /tmp/a.json
    ${suggest(["cookies", "--port", String(plan.endpoints[1].port), "--json"])} > /tmp/b.json
    then diff by (name, domain, path). Duplicate name on different paths is a classic stale-session bug.`);
                }

                if (explicitPort !== undefined) {
                    const others = inventory.endpoints.filter((e) => e.port !== explicitPort);
                    if (others.length > 0) {
                        out.println(
                            `\nOther live endpoints not shown: ${others.map((e) => e.port).join(", ")} (bare '${TOOL_CMD} attach' lists them all).`
                        );
                    }
                }

                out.println(`
Scratch scripts beyond these verbs: ${suggest(["scaffold", "<name>", "--recipe", "redirect-chain"])}
Cheatsheet: ${suggest(["cheatsheet"])}`);
            }

            process.exit(exitCode);
        });
}
