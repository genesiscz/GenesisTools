import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { Command } from "commander";
import { configValueAt, parseConfigPath, parseConfigValue, setConfigValue, unsetConfigValue } from "../lib/config-edit";
import { errorText, fail } from "../lib/shared";

async function show(path: string | undefined, opts: { json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const config = await store.read();
        const value = path ? configValueAt(config, parseConfigPath(path)) : config;

        if (opts.json) {
            out.result(SafeJSON.stringify({ path: store.path, value: value ?? null }, null, 2));
            return;
        }

        out.println(SafeJSON.stringify(value ?? null, null, 2));
        ui.dim(`config: ${store.path}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function set(path: string, text: string, opts: { json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const segments = parseConfigPath(path);
        const config = await setConfigValue(store, path, parseConfigValue(text));
        const value = configValueAt(config, segments);

        if (opts.json) {
            out.result(SafeJSON.stringify({ path: segments, value: value ?? null }, null, 2));
            return;
        }

        ui.ok(`${segments.join(".")} = ${SafeJSON.stringify(value ?? null)}`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function unset(path: string, opts: { json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const segments = parseConfigPath(path);
        const config = await unsetConfigValue(store, path);
        const value = configValueAt(config, segments);

        if (opts.json) {
            out.result(SafeJSON.stringify({ path: segments, value: value ?? null }, null, 2));
            return;
        }

        ui.ok(`${segments.join(".")} is back to ${value === undefined ? "unset" : SafeJSON.stringify(value)}`);
    } catch (err) {
        fail(errorText(err));
    }
}

const PATH_HELP = 'a dotted path (global.capture.activeFps) or a JSON array of keys (["projects","a.b","labels"])';

export function registerConfigCommand(program: Command): void {
    const config = program
        .command("config")
        .description("Read and change the meetings settings: every write is checked against the whole schema first");
    config
        .command("show")
        .argument("[path]", PATH_HELP)
        .description("The settings with their defaults, or the value at one path")
        .option("--json", "print { path, value } as JSON")
        .action(show);
    config
        .command("set")
        .argument("<path>", PATH_HELP)
        .argument("<value>", 'JSON (2, true, ["cs-CZ","en-US"]) or plain text')
        .description("Write one value; nothing is written when the settings would no longer be valid")
        .option("--json", "print { path, value } as JSON")
        .action(set);
    config
        .command("unset")
        .argument("<path>", PATH_HELP)
        .description("Remove one key, so its default applies again")
        .option("--json", "print { path, value } as JSON")
        .action(unset);
}
