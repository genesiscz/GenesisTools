import { getConfig, type PublishedNote } from "@app/dev-dashboard/config";
import { findPublishedBySlug, publishNote, unpublishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { mdKind } from "@app/dev-dashboard/lib/share/kind";
import { importLegacyShare } from "@app/dev-dashboard/lib/share/legacy-share";
import { writeShareSnapshot } from "@app/dev-dashboard/lib/share/snapshot";
import { shareTitle } from "@app/dev-dashboard/lib/share/source";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { publisher, type TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
import { loadPublishConfig } from "@genesiscz/utils/genesis-tools/publish/store";
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
    const { client } = await loadPublishConfig();
    resolveTargets({ targets: client.targets, defaultTarget: client.defaults.target, names: options.targetNames });
    const note = await publishNote(options.vaultPath);

    return { note, outcomes: await sendNote(note, options.targetNames) };
}

export async function syncShares(options: {
    slugs: readonly string[];
    all: boolean;
    targetNames: readonly string[];
}): Promise<Array<{ note: PublishedNote; outcomes: TargetOutcome[] }>> {
    await importLegacyShare();
    const [{ publishedNotes }, { client }, ledger] = await Promise.all([getConfig(), loadPublishConfig(), md.list()]);
    const published = new Set(publishedNotes.map((note) => note.slug));
    const missing = options.slugs.filter((slug) => !published.has(slug));
    if (missing.length > 0) {
        throw new Error(`not published: ${missing.join(", ")}`);
    }

    const byId = new Map(ledger.map((entry) => [entry.id, entry]));
    const notes = options.all ? publishedNotes : publishedNotes.filter((note) => options.slugs.includes(note.slug));
    const results: Array<{ note: PublishedNote; outcomes: TargetOutcome[] }> = [];
    for (const note of notes) {
        const syncs = byId.get(note.slug)?.syncs ?? {};
        const targetNames = options.targetNames.length
            ? options.targetNames
            : client.targets.map(({ name }) => name).filter((name) => Object.hasOwn(syncs, name));
        results.push({ note, outcomes: targetNames.length ? await sendNote(note, targetNames) : [] });
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
