import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { callRunningService } from "@genesiscz/utils/genesis-tools/service/clients";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/** A value from the command line: JSON when it parses (true, 3, "x"), else the text itself. */
function parseValue(text: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        logger.debug({ error }, "config value is plain text");
        return text;
    }
}

export function registerConfigCommand(program: Command): void {
    const config = program.command("config").description("Read and change the config of GenesisTools actions");

    config
        .command("get")
        .description("Print a resolved value (<area>.<key> or <area>.<action>.<key>), or an area's resolved config")
        .argument("<path>")
        .action(async (path: string) => {
            const remote = await callRunningService("config.get", { path });
            const store = createConfigStore({ registry: AREAS });
            out.result(remote.called ? remote.value : path.includes(".") ? store.get(path) : store.resolve(path));
        });

    config
        .command("set")
        .description("Store a value; it is checked against the area's or the action's schema")
        .argument("<path>")
        .argument("<value>")
        .action(async (path: string, value: string) => {
            const remote = await callRunningService("config.set", { path, value: parseValue(value) });
            if (!remote.called) {
                await createConfigStore({ registry: AREAS }).set(path, parseValue(value));
            }
            out.println(`set ${path}`);
        });

    config
        .command("unset")
        .description("Remove a stored value, so the default (or the area's value) applies again")
        .argument("<path>")
        .action(async (path: string) => {
            const remote = await callRunningService("config.unset", { path });
            if (!remote.called) {
                await createConfigStore({ registry: AREAS }).unset(path);
            }
            out.println(`unset ${path}`);
        });
}
