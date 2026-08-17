/**
 * Profile management. Adding a partner here is what unlocks `compat`.
 */
import { emit } from "@app/spotify/commands/_shared";
import { registryPath } from "@app/spotify/lib/paths";
import { DEFAULT_TIMEZONE } from "@app/spotify/lib/profiles";
import { profileAdd, profileDetail, profileList, profileRemove, profileUse } from "@app/spotify/lib/reports/profiles";
import { renderProfileDetail, renderProfileList, renderProfileSaved } from "@app/spotify/render/profiles";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

export function registerProfiles(program: Command): void {
    const profile = program
        .command("profile")
        .description("who the statistics are about — add a partner here to unlock `compat`");

    profile
        .command("list", { isDefault: true })
        .description("every known profile")
        .option("--json", "machine-readable output")
        .action((o: { json?: boolean }) => {
            emit(o.json, profileList(registryPath()), renderProfileList);
        });

    profile
        .command("add <name>")
        .description("register a person's export and/or harvested library")
        .option("--history <dir>", "the unzipped Extended Streaming History folder")
        .option("--data <dir>", "the harvested library folder (spotify_library*.jsonl)")
        .option("--label <text>", "display name used in report headings")
        // No commander default: `profileAdd` keeps an existing profile's timezone when this is
        // omitted, and a default here would silently reset it on every partial update.
        .option("--tz <zone>", `IANA timezone (new profiles use ${DEFAULT_TIMEZONE})`)
        .option("--json", "machine-readable output")
        .action((name: string, o: { history?: string; data?: string; label?: string; tz?: string; json?: boolean }) => {
            const saved = profileAdd({ name, history: o.history, data: o.data, label: o.label, tz: o.tz });
            emit(o.json, saved, renderProfileSaved);
        });

    profile
        .command("use <name>")
        .description("make this the default profile")
        .action((name: string) => {
            profileUse(name);
            out.println(`default profile is now ${pc.green(name)}`);
        });

    profile
        .command("show [name]")
        .description("what a profile points at, and how much data it has")
        .option("--json", "machine-readable output")
        .action((name: string | undefined, o: { json?: boolean }) => {
            emit(o.json, profileDetail(name), renderProfileDetail);
        });

    profile
        .command("rm <name>")
        .description("forget a profile (the files themselves are untouched)")
        .action((name: string) => {
            profileRemove(name);
            out.println(`removed ${name}. Its data files were not deleted.`);
        });
}
