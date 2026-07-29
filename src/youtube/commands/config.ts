import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import type { YoutubeConfigShape } from "@app/youtube/lib/config.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * Thin over `yt.config`, mirroring `PATCH /api/v1/config`.
 *
 * ⚠️ The running server caches config in memory with no file watch, so a value
 * set here is NOT observed by an already-running daemon until it restarts. When
 * the server is up, prefer the HTTP route.
 */

/** Narrows a user-supplied string to a real config key, so indexing stays typed. */
function isConfigKey(config: YoutubeConfigShape, key: string): key is keyof YoutubeConfigShape & string {
    return key in config;
}

export function registerConfigCommand(program: Command): void {
    const config = program.command("config").description("Read and write youtube tool configuration");

    config
        .command("get [key]")
        .description("Print the whole config, or one key")
        .option("--json", "Machine-readable output")
        .action(async (key: string | undefined, _opts: unknown, cmd: Command) => {
            const yt = await getYoutube();
            const all = await yt.config.getAll();

            if (!key) {
                await renderOrEmit({
                    text: SafeJSON.stringify(all, null, 2),
                    json: all,
                    flags: cmd.optsWithGlobals(),
                });
                return;
            }

            if (!isConfigKey(all, key)) {
                out.error(`Unknown config key "${key}". Known: ${Object.keys(all).join(", ")}`);
                process.exitCode = 1;
                return;
            }

            const value = all[key];

            await renderOrEmit({
                text: typeof value === "string" ? value : SafeJSON.stringify(value, null, 2),
                json: { [key]: value },
                flags: cmd.optsWithGlobals(),
            });
        });

    config
        .command("set <key> <value>")
        .description("Set one key; JSON values are parsed, everything else is stored as a string")
        .option("--json", "Machine-readable output")
        .action(async (key: string, value: string, _opts: unknown, cmd: Command) => {
            const yt = await getYoutube();
            const all = await yt.config.getAll();

            if (!isConfigKey(all, key)) {
                out.error(`Unknown config key "${key}". Known: ${Object.keys(all).join(", ")}`);
                process.exitCode = 1;
                return;
            }

            // A bare word is a string; anything JSON-shaped (object, array,
            // number, boolean) is parsed, so `--stages` style values and the
            // `ai` array can both be set from a shell.
            let parsed: unknown = value;

            try {
                parsed = SafeJSON.parse(value);
            } catch {
                // Not JSON, keep the raw string. Deliberately silent: a bare
                // word failing to parse is the expected case, not an error.
            }

            // The cast below erases the type error, so without this check
            // `config set concurrency null` or `config set powerUsers 1` would be
            // persisted and only explode later, in whatever consumer indexed the
            // array or read a member. Compare against the CURRENT value's runtime
            // shape, which is the only schema available here.
            //
            // ⚠️ This catches shape, not VALUE: `config set defaultQuality garbage`
            // is still a string and still passes. Real per-key validation belongs
            // in `yt.config` so the HTTP PATCH route cannot diverge from the CLI.
            // SafeJSON is comment-json, which BOXES scalars so it can hang comment
            // metadata off them: `SafeJSON.parse('"a"')` is a String object, and
            // `typeof` reports "object". Comparing that against a real string
            // would have rejected every valid scalar, so unwrap first.
            const unwrapped =
                parsed instanceof String || parsed instanceof Number || parsed instanceof Boolean
                    ? parsed.valueOf()
                    : parsed;
            const current = all[key];
            const sameShape =
                typeof unwrapped === typeof current &&
                Array.isArray(unwrapped) === Array.isArray(current) &&
                (unwrapped === null) === (current === null);

            if (!sameShape) {
                out.error(
                    `"${key}" is ${Array.isArray(current) ? "an array" : `a ${current === null ? "null" : typeof current}`}, ` +
                        `but ${value} is ${Array.isArray(unwrapped) ? "an array" : `a ${unwrapped === null ? "null" : typeof unwrapped}`}.`
                );
                process.exitCode = 1;
                return;
            }

            await yt.config.set(key, unwrapped as never);
            const updated = await yt.config.getAll();

            await renderOrEmit({
                text: `${key} = ${SafeJSON.stringify(updated[key])}`,
                json: { [key]: updated[key] },
                flags: cmd.optsWithGlobals(),
            });

            out.printlnErr("Note: a running youtube server caches config in memory — restart it to pick this up.");
        });
}
