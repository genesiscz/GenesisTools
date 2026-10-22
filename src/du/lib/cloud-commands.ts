// `tools du downloaded` and `tools du evict`: find the cloud files that are
// downloaded on this disk, and free their local copies. The cloud copy is never
// touched: eviction turns a file back into a dataless placeholder.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { Option } from "commander";
import pc from "picocolors";
import { listCloudFiles } from "./engine";
import { applyEviction, type CloudCtl, type EvictionPlan, planEviction, realCloudCtl } from "./evict";
import { humanBytes, shellQuote, tildePath } from "./format";
import { intOpt } from "./options";
import type { CloudFileEntry, CloudFilesResult } from "./types";

interface ProviderTotal {
    provider: string;
    files: number;
    bytes: number;
}

/** Downloaded bytes per provider, largest first. */
export function totalsByProvider(files: CloudFileEntry[]): ProviderTotal[] {
    const m = new Map<string, ProviderTotal>();
    for (const f of files) {
        const t = m.get(f.provider) ?? { provider: f.provider, files: 0, bytes: 0 };
        t.files++;
        t.bytes += f.alloc;
        m.set(f.provider, t);
    }

    return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

export function renderDownloaded(r: CloudFilesResult, top: number): string {
    const L: string[] = [];
    const total = r.files.reduce((acc, f) => acc + f.alloc, 0);
    L.push(pc.bold(`Downloaded cloud files — ${r.root}`));
    L.push(
        pc.dim(
            `${r.files.length.toLocaleString()} on disk (${humanBytes(total)}) · ` +
                `${r.cloud.dataless_files.toLocaleString()} dataless (${humanBytes(r.cloud.cloud_only_bytes)} cloud-only) · ` +
                `${r.filesListed.toLocaleString()} files listed, none opened`
        )
    );
    L.push("");
    for (const t of totalsByProvider(r.files)) {
        L.push(`  ${humanBytes(t.bytes).padStart(10)}  ${t.files.toLocaleString().padStart(7)} files  ${t.provider}`);
    }

    if (r.files.length > 0) {
        const table = createBoxTable(["ON DISK", "SIZE", "FILE"]);
        for (const f of r.files.slice(0, top)) {
            table.push([humanBytes(f.alloc), humanBytes(f.size), tildePath(f.path)]);
        }

        L.push("");
        L.push(table.toString());
        if (r.files.length > top) {
            L.push(pc.dim(`  ... and ${r.files.length - top} more (--top N)`));
        }

        L.push("");
        L.push(pc.dim("  Free the local copies (the cloud copy stays; dry run unless --apply):"));
        L.push(`     ${toolCommand("du evict")} ${shellQuote(r.root)}`);
    }

    if (r.skippedCloud.length > 0) {
        L.push("");
        L.push(pc.dim(`  ${r.skippedCloud.length} provider root(s) were not walked. Point at one to list it:`));
        for (const s of r.skippedCloud.slice(0, 6)) {
            L.push(pc.dim(`     ${toolCommand("du downloaded")} ${shellQuote(s)}`));
        }
    }

    const dd = r.cloud.dataless_dirs;
    if (dd > 0) {
        L.push(
            pc.dim(`  ${dd.toLocaleString()} dataless folder(s) were not entered (entering one fetches its listing).`)
        );
    }

    return L.join("\n");
}

export interface EvictCliOptions {
    apply?: boolean;
    all?: boolean;
    path?: string[];
}

/**
 * The selection step: explicit --path or --all, else a multiselect on a TTY.
 * Returns null when nothing can be selected without a prompt (non-TTY).
 */
async function selectPaths(plan: EvictionPlan, o: EvictCliOptions): Promise<string[] | null> {
    const eligible = plan.eligible.map((v) => v.file);
    if (o.path && o.path.length > 0) {
        const want = new Set(o.path);
        return eligible.filter((f) => want.has(f.path)).map((f) => f.path);
    }

    if (o.all) {
        return eligible.map((f) => f.path);
    }

    if (!isInteractive()) {
        out.error("Pick the files with --path <file...> or --all in non-interactive mode.");
        out.println(suggestCommand(toolCommand("du"), { add: ["--all"] }));
        process.exitCode = 1;
        return null;
    }

    const picked = await p.multiselect({
        message: "Evict which local copies? (the cloud copy stays)",
        options: eligible.map((f) => ({
            value: f.path,
            label: `${humanBytes(f.alloc).padStart(9)}  ${tildePath(f.path)}`,
        })),
        required: false,
    });
    return picked.map(String);
}

export async function runEvict(opts: {
    root: string;
    files: CloudFileEntry[];
    cli: EvictCliOptions;
    ctl?: CloudCtl;
}): Promise<void> {
    const ctl = opts.ctl ?? realCloudCtl;
    const plan = await planEviction(opts.files, ctl);

    if (plan.refused.length > 0) {
        out.println(pc.yellow(`  ${plan.refused.length} file(s) are not evictable:`));
        const byReason = new Map<string, number>();
        for (const v of plan.refused) {
            byReason.set(v.reason, (byReason.get(v.reason) ?? 0) + 1);
        }

        for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
            out.println(pc.dim(`     ${n.toLocaleString().padStart(6)}  ${reason}`));
        }
    }

    if (plan.eligible.length === 0) {
        out.println(
            `Nothing is safe to evict: none of the ${opts.files.length} offered file(s) is confirmed uploaded.`
        );
        return;
    }

    const selected = await selectPaths(plan, opts.cli);
    if (selected === null) {
        return;
    }

    const chosen = plan.eligible.filter((v) => selected.includes(v.file.path)).map((v) => v.file);
    const bytes = chosen.reduce((acc, f) => acc + f.alloc, 0);
    if (chosen.length === 0) {
        out.println("Nothing selected.");
        return;
    }

    if (!opts.cli.apply) {
        out.println(pc.bold(`DRY RUN: would evict ${chosen.length} file(s), freeing ${humanBytes(bytes)}:`));
        for (const f of chosen.slice(0, 50)) {
            out.println(`     ${humanBytes(f.alloc).padStart(9)}  ${tildePath(f.path)}`);
        }

        if (chosen.length > 50) {
            out.println(pc.dim(`     ... and ${chosen.length - 50} more`));
        }

        out.println(
            pc.dim("  Run again with --apply to evict them. Each file is re-checked right before its eviction.")
        );
        return;
    }

    const results = await applyEviction(
        plan,
        chosen.map((f) => f.path),
        ctl
    );
    const ok = results.filter((r) => r.evicted);
    const freed = chosen.filter((f) => ok.some((r) => r.path === f.path)).reduce((acc, f) => acc + f.alloc, 0);
    out.println(pc.green(`Evicted ${ok.length} of ${chosen.length} file(s), about ${humanBytes(freed)} freed.`));
    for (const r of results.filter((x) => !x.evicted)) {
        out.println(pc.yellow(`     not evicted: ${tildePath(r.path)} (${r.reason ?? "unknown"})`));
    }
}

export function registerCloudCommands(program: Command): void {
    program
        .command("downloaded")
        .description("List cloud files (iCloud, File Provider folders) that are downloaded on this disk")
        .argument("<dir>", "Folder to look in (a home folder, ~/Documents, a provider folder ...)")
        .addOption(new Option("--format <fmt>", "Output format").choices(["human", "json"]).default("human"))
        .option("--min-bytes <n>", "Only files with at least N allocated bytes", intOpt("--min-bytes", { min: 0 }))
        .option("--top <n>", "Rows to show (default 30)", intOpt("--top", { min: 1 }))
        .option("--threads <n>", "Worker threads (default: number of CPUs)", intOpt("--threads", { min: 1, max: 1024 }))
        .option("--include-cloud", "Also walk ~/Library/CloudStorage and iCloud Drive under <dir> (listing only)")
        .addHelpText(
            "after",
            [
                "",
                "A listing walk only: no file is opened and no dataless folder is entered, so it",
                "cannot download anything. A file counts when it sits inside a File Provider domain",
                "(it carries the com.apple.file-provider-domain-id xattr on its root) and is not dataless.",
                "",
                `  ${toolCommand("du downloaded")} ~/Documents`,
                `  ${toolCommand("du downloaded")} ~ --min-bytes 10000000`,
            ].join("\n")
        )
        .action(
            (
                dir: string,
                o: {
                    format: "human" | "json";
                    minBytes?: number;
                    top?: number;
                    threads?: number;
                    includeCloud?: boolean;
                }
            ) => {
                const root = resolveDir(dir);
                const r = listCloudFiles({
                    root,
                    minBytes: o.minBytes,
                    threads: o.threads,
                    includeCloud: o.includeCloud,
                });
                if (o.format === "json") {
                    out.result(r);
                    return;
                }

                out.println(renderDownloaded(r, o.top ?? 30));
            }
        );

    program
        .command("evict")
        .description("Free the local copy of downloaded iCloud files that are confirmed uploaded (dry run by default)")
        .argument("<dir>", "Folder whose downloaded cloud files to offer")
        .option("--apply", "Really evict. Without it this is a dry run that changes nothing")
        .option("--all", "Select every eligible file (non-interactive)")
        .option("--path <file...>", "Select these files only (each must be eligible)")
        .option(
            "--min-bytes <n>",
            "Only offer files with at least N allocated bytes",
            intOpt("--min-bytes", { min: 0 })
        )
        .option("--top <n>", "Offer the N largest files (default 50)", intOpt("--top", { min: 1 }))
        .option("--threads <n>", "Worker threads (default: number of CPUs)", intOpt("--threads", { min: 1, max: 1024 }))
        .addHelpText(
            "after",
            [
                "",
                "Lists the downloaded cloud files (like `downloaded`), asks iCloud for each file's",
                "upload state, lets you pick, then evicts. Eviction never deletes: the file stays in",
                "iCloud and downloads again when opened.",
                "",
                "Refused, always: a file not confirmed uploaded, one still uploading or with an upload",
                "error, a local copy that is not the current version, Tresorit files (only a content",
                "read through the mount proves the server has them), and other providers.",
                "",
                `  ${toolCommand("du evict")} ~/Documents                  # pick, dry run`,
                `  ${toolCommand("du evict")} ~/Documents --all --apply    # evict every eligible file`,
            ].join("\n")
        )
        .action(async (dir: string, o: EvictCliOptions & { minBytes?: number; top?: number; threads?: number }) => {
            const root = resolveDir(dir);
            const listing = listCloudFiles({ root, minBytes: o.minBytes, threads: o.threads });
            const paths = o.path?.map((x) => resolve(x));
            const want = paths ? new Set(paths) : null;
            const files = want ? listing.files.filter((f) => want.has(f.path)) : listing.files.slice(0, o.top ?? 50);
            logger.debug({ root, listed: listing.files.length, offered: files.length }, "du evict: candidates");
            renderCliHeader("Evict local copies", root);
            if (files.length === 0) {
                out.println("No downloaded cloud files found here.");
                return;
            }

            await runEvict({
                root,
                files,
                cli: { apply: o.apply, all: o.all, path: paths },
            });
        });
}

function resolveDir(dir: string): string {
    const root = resolve(dir);
    let ok = false;
    try {
        ok = existsSync(root) && statSync(root).isDirectory();
    } catch (err) {
        logger.debug({ err, root }, "du: stat of the folder failed");
    }

    if (!ok) {
        out.error(`Not a directory: ${root}`);
        process.exit(1);
    }

    return root;
}
