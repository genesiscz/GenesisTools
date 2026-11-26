import { resolvePublishedSlug, shareNote } from "@app/dev-dashboard/lib/obsidian/share-note";
import { pruneTargets, syncShares, type TargetOutcome, unshareFromTargets } from "@app/dev-dashboard/lib/share/targets";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { out } from "@genesiscz/utils/logger";

export interface ShareCommandOptions {
    clipboard: boolean;
    /** `--target` values; empty uses the publish default, "all" every target. */
    targets: string[];
}

function printOutcomes(outcomes: TargetOutcome[]): boolean {
    let failed = false;

    for (const outcome of outcomes) {
        if (outcome.error) {
            failed = true;
            out.printlnErr(`${outcome.target}: failed: ${outcome.error}`);
        } else if (outcome.url) {
            out.println(outcomes.length > 1 ? `${outcome.target}\t${outcome.url}` : outcome.url);
        } else {
            out.printlnErr(`${outcome.target}: done`);
        }
    }

    return !failed;
}

async function guarded(fn: () => Promise<boolean>): Promise<void> {
    try {
        if (!(await fn())) {
            process.exitCode = 1;
        }
    } catch (err) {
        out.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    }

    await out.flush();
}

/**
 * Same path as the Obsidian reader "publish" button: register a `/share/<slug>` token, send the note to the chosen
 * share targets, print each target's link and copy the first one.
 */
export async function runShare(path: string, opts: ShareCommandOptions): Promise<void> {
    await guarded(async () => {
        const { vaultPath, outcomes } = await shareNote(path, opts.targets);
        const ok = printOutcomes(outcomes);
        out.printlnErr(`published ${vaultPath}`);
        const first = outcomes.find((outcome) => outcome.url)?.url;

        if (opts.clipboard && first) {
            await copyToClipboard(first, { label: "share URL" });
        }

        return ok;
    });
}

/** `share sync [notes...] [--all] [--target <name>] [--prune]`: send published notes again. */
export async function runShareSync(
    notes: string[],
    opts: { all: boolean; targets: string[]; prune: boolean }
): Promise<void> {
    await guarded(async () => {
        if (!opts.all && notes.length === 0 && !opts.prune) {
            throw new Error("name a note or slug, or pass --all");
        }

        const slugs = await Promise.all(notes.map(resolvePublishedSlug));
        let ok = true;

        if (opts.all || slugs.length > 0) {
            for (const { note, outcomes } of await syncShares({ slugs, all: opts.all, targetNames: opts.targets })) {
                out.printlnErr(`${note.vaultPath} (${note.slug})`);

                if (outcomes.length === 0) {
                    out.printlnErr("  sent to no target before; name one with --target <name>");
                }

                ok = printOutcomes(outcomes) && ok;
            }
        }

        if (opts.prune) {
            for (const { target, removed } of await pruneTargets(opts.targets)) {
                out.printlnErr(
                    `${target}: removed ${removed.length} stale snapshot(s)${removed.length ? `: ${removed.join(", ")}` : ""}`
                );
            }
        }

        return ok;
    });
}

/** `share unshare <note|slug> [--target <name>]`: off those targets, or off every target and unpublished. */
export async function runUnshare(input: string, opts: { targets: string[] }): Promise<void> {
    await guarded(async () => {
        const slug = await resolvePublishedSlug(input);
        const outcomes = await unshareFromTargets({ slug, targetNames: opts.targets });

        return printOutcomes(outcomes);
    });
}
