import { getConfig, type PublishedNote, saveConfig, withConfigMutation } from "@app/dev-dashboard/config";
import { findPublishedBySlug, publishNote, unpublishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { mdKind } from "@app/dev-dashboard/lib/share/kind";
import { importLegacyShare } from "@app/dev-dashboard/lib/share/legacy-share";
import { writeShareSnapshot } from "@app/dev-dashboard/lib/share/snapshot";
import { shareTitle } from "@app/dev-dashboard/lib/share/source";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { publisher, type TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
import { loadShareConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { logger } from "@genesiscz/utils/logger";
import { isEditedAfterSync } from "@genesiscz/utils/publish/freshness";
import { resolveTargets } from "@genesiscz/utils/publish/targets";

export type { TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
export { ALL_TARGETS } from "@genesiscz/utils/publish/targets";

const { log } = logger.scoped("share-targets");
const md = publisher(mdKind);

async function sendNote(note: PublishedNote, targetNames: readonly string[]): Promise<TargetOutcome[]> {
    const source = vaultShareSource();
    const sourceModifiedAt = (await source.freshness(note)).editedAt;
    const { outcomes } = await md.publish({
        id: note.slug,
        source: note.vaultPath,
        title: shareTitle(note.vaultPath),
        sourceModifiedAt,
        targetNames,
        build: async ({ dir }) => {
            if (!(await findPublishedBySlug(note.slug))) {
                throw new Error(`Note is no longer published: ${note.slug}`);
            }

            await writeShareSnapshot({ source, note, dir, sourceModifiedAt });
        },
    });

    const config = await loadShareConfig();
    const live = new Set(
        config.targets.filter((target) => target.transport.kind === "mac-live").map((target) => target.name)
    );
    if (outcomes.some((outcome) => live.has(outcome.target) && !outcome.error)) {
        await setLivePublished(note.slug, true);
    }

    return outcomes;
}

async function setLivePublished(slug: string, live: boolean): Promise<void> {
    await withConfigMutation(async () => {
        const config = await getConfig();
        await saveConfig({
            ...config,
            publishedNotes: config.publishedNotes.map((note) => (note.slug === slug ? { ...note, live } : note)),
        });
    });
}

/** Send the UI's newly published note without making the page wait. */
export function shareInBackground(note: PublishedNote): void {
    void (async () => {
        await importLegacyShare();
        await sendNote(note, []);
    })().catch((err: unknown) => {
        log.warn({ err, slug: note.slug }, "background share failed");
    });
}

export async function shareToTargets(options: {
    vaultPath: string;
    targetNames: readonly string[];
}): Promise<{ note: PublishedNote; outcomes: TargetOutcome[] }> {
    await importLegacyShare();
    const config = await loadShareConfig();
    resolveTargets({ targets: config.targets, defaultTarget: config.defaults.target, names: options.targetNames });
    const note = await publishNote(options.vaultPath);

    return { note, outcomes: await sendNote(note, options.targetNames) };
}

export async function syncShares(options: {
    slugs: readonly string[];
    all: boolean;
    targetNames: readonly string[];
    pickFallback?: (candidates: string[]) => Promise<string | null>;
    /** Only notes edited since their last sync to each target (or never sent there); a note whose vault file is gone is skipped. */
    changedOnly?: boolean;
}): Promise<Array<{ note: PublishedNote; outcomes: TargetOutcome[] }>> {
    await importLegacyShare();
    const [{ publishedNotes }, config, ledger] = await Promise.all([getConfig(), loadShareConfig(), md.list()]);
    const published = new Set(publishedNotes.map((note) => note.slug));
    const missing = options.slugs.filter((slug) => !published.has(slug));
    if (missing.length > 0) {
        throw new Error(`not published: ${missing.join(", ")}`);
    }

    const byId = new Map(ledger.map((entry) => [entry.id, entry]));
    const selected = options.all ? publishedNotes : publishedNotes.filter((note) => options.slugs.includes(note.slug));
    const notes: PublishedNote[] = [];
    const edits = new Map<string, string>();
    for (const note of selected) {
        if (options.changedOnly) {
            const { editedAt } = await vaultShareSource().freshness(note);
            if (!editedAt) {
                log.debug({ slug: note.slug }, "share sync --changed: source missing");
                continue;
            }

            edits.set(note.slug, editedAt);
        }

        notes.push(note);
    }

    const candidates = config.targets.map(({ name }) => name);
    const previousTargets = (note: PublishedNote) =>
        candidates.filter((name) => Object.hasOwn(byId.get(note.slug)?.syncs ?? {}, name));
    let fallback: string[] = [];
    let fallbackCancelled = false;
    if (!options.targetNames.length && !config.defaults.target && notes.some((note) => !previousTargets(note).length)) {
        if (!options.pickFallback) {
            throw new Error("Choose a share target for notes that have yet to be sent.");
        }

        const picked = await options.pickFallback(candidates);
        fallbackCancelled = picked === null;
        fallback = picked ? [picked] : [];
    }

    const results: Array<{ note: PublishedNote; outcomes: TargetOutcome[] }> = [];
    for (const note of notes) {
        const previous = previousTargets(note);
        if (fallbackCancelled && !options.targetNames.length && !previous.length) {
            continue;
        }

        let targetNames = options.targetNames.length ? options.targetNames : previous.length ? previous : fallback;
        if (options.changedOnly) {
            const syncs = byId.get(note.slug)?.syncs ?? {};
            const editedAt = edits.get(note.slug);
            targetNames = resolveTargets({
                targets: config.targets,
                defaultTarget: config.defaults.target,
                names: targetNames,
            })
                .filter((target) => !syncs[target.name] || isEditedAfterSync(editedAt, syncs[target.name]))
                .map((target) => target.name);
            if (!targetNames.length) {
                log.debug({ slug: note.slug, editedAt }, "share sync --changed: up to date");
                continue;
            }
        }

        // One note that cannot be built (its vault file moved or was deleted) must not stop the notes after it.
        try {
            results.push({ note, outcomes: await sendNote(note, targetNames) });
        } catch (error) {
            // The outcome line below already tells the user; the stack goes to the day log only.
            log.debug({ error, slug: note.slug, vaultPath: note.vaultPath }, "share sync: note not sent");
            const reason = error instanceof Error ? error.message : String(error);
            results.push({ note, outcomes: [{ target: targetNames.join(", ") || "default target", error: reason }] });
        }
    }

    return results;
}

export async function pruneTargets(
    targetNames: readonly string[]
): Promise<Array<{ target: string; removed: string[] }>> {
    await importLegacyShare();
    return md.prune(targetNames);
}

/** Remove the live slug only after the last tracked target is gone. */
export async function unshareFromTargets(options: {
    slug: string;
    targetNames: readonly string[];
}): Promise<TargetOutcome[]> {
    await importLegacyShare();
    const note = await findPublishedBySlug(options.slug);
    if (!note && !(await md.find({ id: options.slug }))) {
        throw new Error(`not published: ${options.slug}`);
    }

    const outcomes = await md.unpublish({ id: options.slug, targetNames: options.targetNames });
    const config = await loadShareConfig();
    const live = new Set(
        config.targets.filter((target) => target.transport.kind === "mac-live").map((target) => target.name)
    );
    if (outcomes.some((outcome) => live.has(outcome.target) && !outcome.error)) {
        await setLivePublished(options.slug, false);
    }

    if (!outcomes.some((outcome) => outcome.error) && !(await md.find({ id: options.slug }))) {
        await unpublishNote(options.slug);
    }

    return outcomes;
}
