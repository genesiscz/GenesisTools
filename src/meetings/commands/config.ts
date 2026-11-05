import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import type { Command } from "commander";
import { z } from "zod";
import {
    applyConfigEdits,
    type ConfigEdit,
    configValueAt,
    parseConfigPath,
    parseConfigValue,
    setConfigValue,
    unsetConfigValue,
} from "../lib/config-edit";
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

function expectOption(opts: { expect?: string }): { expect?: unknown } {
    return opts.expect === undefined ? {} : { expect: parseConfigValue(opts.expect) };
}

async function set(path: string, text: string, opts: { expect?: string; json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const segments = parseConfigPath(path);
        const config = await setConfigValue(store, path, parseConfigValue(text), expectOption(opts));
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

async function unset(path: string, opts: { expect?: string; json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const segments = parseConfigPath(path);
        const config = await unsetConfigValue(store, path, expectOption(opts));
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

const configEditSchema = z.union([
    z.object({ path: z.string().min(1), value: z.unknown(), expect: z.unknown().optional() }).strict(),
    z.object({ path: z.string().min(1), unset: z.literal(true), expect: z.unknown().optional() }).strict(),
]);

async function edit(text: string, opts: { json?: boolean }): Promise<void> {
    const store = new MeetingsConfigStore();

    try {
        const parsed = z
            .array(configEditSchema)
            .min(1)
            .safeParse(SafeJSON.parse(text, { strict: true }));

        if (!parsed.success) {
            fail(
                "config edit takes a JSON array of { path, value, expect? } or { path, unset: true, expect? } (expect: the value the change replaces)"
            );
            return;
        }

        const edits: ConfigEdit[] = parsed.data.map((one) =>
            "unset" in one
                ? { path: one.path, unset: true, ...("expect" in one ? { expect: one.expect } : {}) }
                : { path: one.path, value: one.value, ...("expect" in one ? { expect: one.expect } : {}) }
        );
        const config = await applyConfigEdits(store, edits);
        const values = edits.map((one) => {
            const segments = parseConfigPath(one.path);
            return { path: segments, value: configValueAt(config, segments) ?? null };
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(values, null, 2));
            return;
        }

        for (const one of values) {
            ui.ok(`${one.path.join(".")} = ${SafeJSON.stringify(one.value)}`);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

const EXPECT_HELP =
    "JSON: the value (with its default) this change replaces; refused with [config-stale] when another editor changed it";

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
        .option("--expect <json>", EXPECT_HELP)
        .option("--json", "print { path, value } as JSON")
        .action(set);
    config
        .command("unset")
        .argument("<path>", PATH_HELP)
        .description("Remove one key, so its default applies again")
        .option("--expect <json>", EXPECT_HELP)
        .option("--json", "print { path, value } as JSON")
        .action(unset);
    config
        .command("edit")
        .argument("<edits>", 'JSON array: [{ "path": …, "value": …, "expect": … }, { "path": …, "unset": true }]')
        .description("Several changes in one write: all of them, or none when one is refused")
        .option("--json", "print [{ path, value }] as JSON")
        .action(edit);
}
