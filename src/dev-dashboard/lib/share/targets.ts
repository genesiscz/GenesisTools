import { getConfig, type PublishedNote } from "@app/dev-dashboard/config";
import { findPublishedBySlug, publishNote, unpublishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { mdKind } from "@app/dev-dashboard/lib/share/kind";
import { importLegacyShare } from "@app/dev-dashboard/lib/share/legacy-share";
import { writeShareSnapshot } from "@app/dev-dashboard/lib/share/snapshot";
import { shareTitle } from "@app/dev-dashboard/lib/share/source";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { publisher, type TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
import { loadShareConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { logger } from "@genesiscz/utils/logger";
import { resolveTargets } from "@genesiscz/utils/publish/targets";

export type { TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
export { ALL_TARGETS } from "@genesiscz/utils/publish/targets";

const { log } = logger.scoped("share-targets");
const md = publisher(mdKind);

async function sendNote(note: PublishedNote, targetNames: readonly string[]): Promise<TargetOutcome[]> {
    const source = vaultShareSource();
    const { outcomes } = await md.publish({
        id: note.slug,
        source: note.vaultPath,
        title: shareTitle(note.vaultPath),
        sourceModifiedAt: (await source.freshness(note)).editedAt,
        targetNames,
        build: async ({ dir }) => {
            if (!(await findPublishedBySlug(note.slug))) {
                throw new Error(`Note is no longer published: ${note.slug}`);
            }

            await writeShareSnapshot({ source, note, dir });
        },
    });

    return outcomes;
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

/** The UI has already removed the live slug. Remove the copies tracked in the ledger. */
export function unshareInBackground(note: PublishedNote): void {
    void (async () => {
        await importLegacyShare();
        await md.unpublish({ id: note.slug, targetNames: [] });
    })().catch((err: unknown) => {
        log.warn({ err, slug: note.slug }, "background unshare failed");
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
}): Promise<Array<{ note: PublishedNote; outcomes: TargetOutcome[] }>> {
    await importLegacyShare();
    const [{ publishedNotes }, config, ledger] = await Promise.all([getConfig(), loadShareConfig(), md.list()]);
    const published = new Set(publishedNotes.map((note) => note.slug));
    const missing = options.slugs.filter((slug) => !published.has(slug));
    if (missing.length > 0) {
        throw new Error(`not published: ${missing.join(", ")}`);
    }

    const byId = new Map(ledger.map((entry) => [entry.id, entry]));
    const notes = options.all ? publishedNotes : publishedNotes.filter((note) => options.slugs.includes(note.slug));
    const candidates = config.targets.map(({ name }) => name);
    const previousTargets = (note: PublishedNote) =>
        candidates.filter((name) => Object.hasOwn(byId.get(note.slug)?.syncs ?? {}, name));
    let fallback: string[] = [];
    if (!options.targetNames.length && !config.defaults.target && notes.some((note) => !previousTargets(note).length)) {
        if (!options.pickFallback) {
            throw new Error("Choose a share target for notes that have yet to be sent.");
        }

        const picked = await options.pickFallback(candidates);
        if (!picked) {
            return [];
        }

        fallback = [picked];
    }

    const results: Array<{ note: PublishedNote; outcomes: TargetOutcome[] }> = [];
    for (const note of notes) {
        const previous = previousTargets(note);
        const targetNames = options.targetNames.length ? options.targetNames : previous.length ? previous : fallback;
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
    if (!note) {
        throw new Error(`not published: ${options.slug}`);
    }

    const outcomes = await md.unpublish({ id: note.slug, targetNames: options.targetNames });
    if (!outcomes.some((outcome) => outcome.error) && !(await md.find({ id: note.slug }))) {
        await unpublishNote(note.slug);
    }

    return outcomes;
}
