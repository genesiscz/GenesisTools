import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliKeyRow } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { wakeRelay } from "../lib/wake/index";

/**
 * `tools hub wake`: the wakeup relay this Mac is registered with, as the phone's Wake my Mac screen keeps it
 * (`/api/gateway/wake`). `--json` prints the login too, because the phone needs it; the table masks it.
 */
export function registerWakeCommand(program: Command): void {
    program
        .command("wake")
        .description("The wakeup relay the phone uses to wake this Mac")
        .option("--json", "machine-readable output, the relay login included")
        .action(async (opts: { json?: boolean }) => {
            const relay = await wakeRelay();

            if (opts.json) {
                out.result(relay);
                return;
            }

            renderCliHeader("Wake my Mac", relay.configured ? "relay set" : "no relay");
            renderCliKeyRow("Relay", relay.url ?? "-");
            renderCliKeyRow("Device", relay.name ?? "-");
            renderCliKeyRow("Password", relay.password ? "set" : "-");
            renderCliKeyRow("Token", relay.token ? "set" : "-");

            if (relay.note) {
                out.log.warn(relay.note);
            }
        });
}
