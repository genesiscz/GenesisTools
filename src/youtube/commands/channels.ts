import { readFileSync } from "node:fs";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { confirmDestructive } from "@app/youtube/commands/_shared/confirm";
import { getYoutube } from "@app/youtube/commands/_shared/ensure-pipeline";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import { normaliseHandle, validateHandle } from "@app/youtube/commands/_shared/utils";
import type { ChannelHandle } from "@app/youtube/lib/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface SyncOpts {
    all?: boolean;
    limit: number;
    includeShorts?: boolean;
    since?: string;
}

export function registerChannelsCommand(program: Command): void {
    const cmd = program.command("channels").description("Manage saved YouTube channels");

    cmd.command("add")
        .description("Add one or more channels by handle")
        .argument("[handles...]", "Handles like @mkbhd or YouTube channel URLs")
        .option("--from-file <path>", "Read newline-delimited handles from a file")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube channels add @mkbhd @veritasium\n  $ tools youtube channels add --from-file my-subs.txt\n"
        )
        .action(async (handles: string[], opts: { fromFile?: string }) => {
            const yt = await getYoutube();
            const inputs = [...handles];

            if (opts.fromFile) {
                inputs.push(
                    ...readFileSync(opts.fromFile, "utf8")
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean)
                );
            }

            if (!inputs.length) {
                if (!isInteractive()) {
                    console.error(pc.red("channels add requires at least one handle, or --from-file."));
                    console.error(`Try: ${suggestCommand("tools youtube channels add", { add: ["@mkbhd"] })}`);
                    process.exitCode = 1;
                    return;
                }

                const result = await p.text({
                    message: "Channel handle to add (e.g. @mkbhd):",
                    validate: validateHandle,
                });
                if (p.isCancel(result)) {
                    return;
                }

                inputs.push(result);
            }

            const handlesNorm = inputs.map(normaliseHandle);
            for (const handle of handlesNorm) {
                await yt.channels.add(handle);
            }

            await renderOrEmit({
                text: `Added ${handlesNorm.length} channel(s): ${handlesNorm.join(", ")}`,
                json: { added: handlesNorm },
                flags: cmd.optsWithGlobals(),
            });
        });

    cmd.command("list")
        .description("List saved channels")
        .addHelpText("after", "\nExamples:\n  $ tools youtube channels list\n  $ tools youtube --json channels list\n")
        .action(async () => {
            const yt = await getYoutube();
            const channels = yt.channels.list();
            const text = renderColumns({
                rows: channels,
                emptyMessage: "No saved channels — try `tools youtube channels add @mkbhd`.",
                schema: [
                    { header: "Handle", get: (channel) => channel.handle, minWidth: 16 },
                    { header: "Title", get: (channel) => channel.title ?? pc.dim("—"), maxWidth: 40 },
                    {
                        header: "Videos",
                        get: (channel) => (channel.lastSyncedAt ? "synced" : pc.dim("not synced")),
                        minWidth: 10,
                    },
                    {
                        header: "Last sync",
                        get: (channel) => channel.lastSyncedAt ?? "—",
                        color: (value) => pc.dim(value),
                    },
                ],
            });

            await renderOrEmit({ text, json: channels, flags: cmd.optsWithGlobals() });
        });

    cmd.command("remove")
        .description("Remove a saved channel and all of its cached data")
        .argument("<handle>", "Channel handle, e.g. @mkbhd")
        .option("--yes", "Skip confirmation")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube channels remove @mkbhd\n  $ tools youtube channels remove @mkbhd --yes\n"
        )
        .action(async (rawHandle: string, opts: { yes?: boolean }) => {
            const handle = normaliseHandle(rawHandle);
            const yt = await getYoutube();
            const ok =
                opts.yes ||
                (await confirmDestructive({
                    message: `permanently remove channel ${handle} and all cached videos/transcripts`,
                    assumeYesFlag: "--yes",
                }));

            if (!ok) {
                return;
            }

            yt.channels.remove(handle);
            await renderOrEmit({ text: `Removed ${handle}`, json: { removed: handle }, flags: cmd.optsWithGlobals() });
        });

    cmd.command("sync")
        .description("Refresh video listings for one or all saved channels")
        .argument("[handle]", "Channel handle to sync; omit to sync the prompted channel")
        .option("--all", "Sync every saved channel")
        .option("--limit <n>", "Max videos per channel (default 30)", (value) => Number.parseInt(value, 10), 30)
        .option("--include-shorts", "Include Shorts in the sync")
        .option("--since <date>", "Only sync uploads on/after YYYY-MM-DD")
        .addHelpText(
            "after",
            "\nExamples:\n  $ tools youtube channels sync @mkbhd --limit 100\n  $ tools youtube channels sync --all\n"
        )
        .action(async (handleArg: string | undefined, opts: SyncOpts) => {
            const yt = await getYoutube();
            const targets = await resolveSyncTargets({ yt, handleArg, all: opts.all });

            if (!targets.length) {
                return;
            }

            const results: Array<{ handle: ChannelHandle; count: number; error?: string }> = [];
            for (const handle of targets) {
                try {
                    const count = await yt.channels.sync(handle, {
                        limit: opts.limit,
                        includeShorts: opts.includeShorts,
                    });
                    results.push({ handle, count });
                } catch (error) {
                    results.push({ handle, count: 0, error: error instanceof Error ? error.message : String(error) });
                }
            }

            const text = renderColumns({
                rows: results,
                schema: [
                    { header: "Channel", get: (row) => row.handle },
                    {
                        header: "Synced",
                        get: (row) => (row.error ? pc.red("error") : pc.green(String(row.count))),
                        align: "right",
                        minWidth: 8,
                    },
                    { header: "Error", get: (row) => row.error ?? "" },
                ],
            });

            await renderOrEmit({ text, json: results, flags: cmd.optsWithGlobals() });
        });
}

async function resolveSyncTargets({
    yt,
    handleArg,
    all,
}: {
    yt: Awaited<ReturnType<typeof getYoutube>>;
    handleArg?: string;
    all?: boolean;
}): Promise<ChannelHandle[]> {
    if (all) {
        return yt.channels.list().map((channel) => channel.handle);
    }

    if (handleArg) {
        return [normaliseHandle(handleArg)];
    }

    if (!isInteractive()) {
        console.error(pc.red("channels sync requires <handle> or --all in non-interactive mode."));
        console.error(`Try: ${suggestCommand("tools youtube channels sync", { add: ["--all"] })}`);
        process.exitCode = 1;
        return [];
    }

    const channels = yt.channels.list();
    if (!channels.length) {
        console.error(pc.yellow("No saved channels."));
        return [];
    }

    const answer = await p.select({
        message: "Sync which channel?",
        options: channels.map((channel) => ({
            value: channel.handle,
            label: channel.title ?? channel.handle,
            hint: channel.handle,
        })),
    });

    return p.isCancel(answer) ? [] : [answer];
}
