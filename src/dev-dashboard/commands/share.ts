import { resolvePublishedSlug, shareNote } from "@app/dev-dashboard/lib/obsidian/share-note";
import { loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { pruneTargets, syncShares, type TargetOutcome, unshareFromTargets } from "@app/dev-dashboard/lib/share/targets";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { formatMissingEnumHelp, suggestCommand } from "@genesiscz/utils/cli/executor";
import { isInteractive } from "@genesiscz/utils/cli/is-interactive";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { out } from "@genesiscz/utils/logger";

const SHARE_TOOL = "tools dev-dashboard";

export function pickShareTarget(input: {
    given: string | true;
    candidates: readonly string[];
    subcommand: string[];
    all?: boolean;
}): Promise<string | null> {
    const values = [...input.candidates, ...(input.all === false ? [] : ["all"])];
    const accepts = (value: string): value is string => values.includes(value);
    if (input.given === true ? !isInteractive() : !accepts(input.given)) {
        out.printlnErr(
            formatMissingEnumHelp({
                flag: "--target",
                values,
                given: typeof input.given === "string" ? input.given : undefined,
                suggestion: suggestCommand(SHARE_TOOL, {
                    replaceCommand: [...input.subcommand, "--target", values[0] ?? "<name>"],
                }),
            })
        );
        process.exitCode = 1;
        return Promise.resolve(null);
    }

    return pickEnumFlag({
        tool: SHARE_TOOL,
        subcommand: input.subcommand,
        flag: "--target",
        given: input.given,
        values,
        fallback: values[0] ?? "all",
        accepts,
    });
}

export async function resolveShareTargetFlags(
    values: Array<string | true>,
    subcommand: string[]
): Promise<string[] | null> {
    if (!values.length) {
        return [];
    }

    const candidates = (await loadSharePublishConfig()).targets.map(({ name }) => name);
    const targets = new Set<string>();
    for (const given of values) {
        const target = await pickShareTarget({ given, candidates, subcommand });
        if (!target) {
            return null;
        }

        targets.add(target);
    }

    return [...targets];
}

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
        const { vaultPath, outcomes, alreadyPublished, slug } = await shareNote(path, opts.targets);
        const ok = printOutcomes(outcomes);
        out.printlnErr(
            alreadyPublished
                ? `already published as ${slug}: ${vaultPath} was sent again, the link stays the same`
                : `published ${vaultPath}`
        );
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
    opts: { all: boolean; targets: string[]; prune: boolean; changed?: boolean }
): Promise<void> {
    await guarded(async () => {
        if (!opts.all && notes.length === 0 && !opts.prune) {
            throw new Error("name a note or slug, or pass --all");
        }

        const slugs = await Promise.all(notes.map(resolvePublishedSlug));
        let ok = true;

        if (opts.all || slugs.length > 0) {
            let needsTarget = false;
            const results = await syncShares({
                slugs,
                all: opts.all,
                targetNames: opts.targets,
                changedOnly: opts.changed,
                pickFallback: async (candidates) => {
                    const subcommand = [
                        "share",
                        "sync",
                        ...notes,
                        ...(opts.all ? ["--all"] : []),
                        ...(opts.prune ? ["--prune"] : []),
                    ];
                    const picked = await pickShareTarget({ given: true, candidates, subcommand });
                    needsTarget = !picked;
                    return picked;
                },
            });
            if (needsTarget) {
                return false;
            }

            if (opts.changed && results.length === 0) {
                out.printlnErr("nothing changed since the last sync");
            }

            for (const { note, outcomes } of results) {
                out.printlnErr(`${note.vaultPath} (${note.slug})`);

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
