import type { PublishedNote } from "@app/dev-dashboard/config";
import { getConfig } from "@app/dev-dashboard/config";
import {
    findPublishedBySlug,
    listPublished,
    publishNote,
    setPublishedTargets,
    unpublishNote,
} from "@app/dev-dashboard/lib/obsidian/publish";
import { driverFor } from "@app/dev-dashboard/lib/share/drivers";
import type { ShareConfig, ShareTarget } from "@app/dev-dashboard/lib/share/drivers/options";
import { vaultShareSource } from "@app/dev-dashboard/lib/share/vault-source";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("share-targets");

/** `--target all` names every configured target. */
export const ALL_TARGETS = "all";

export interface TargetOutcome {
    target: string;
    url?: string;
    error?: string;
}

/** The targets `names` picks: none given is the default target, "all" is every target. Unknown names throw. */
export function resolveTargets(share: ShareConfig, names: readonly string[]): ShareTarget[] {
    const wanted = names.length === 0 ? [share.defaults.target] : names;

    if (wanted.includes(ALL_TARGETS)) {
        return share.targets;
    }

    return wanted.map((name) => {
        const target = share.targets.find((entry) => entry.name === name);

        if (!target) {
            const known = share.targets.map((entry) => entry.name).join(", ");
            throw new Error(`no share target "${name}" (configured: ${known || "none"})`);
        }

        return target;
    });
}

async function sendTo(targets: ShareTarget[], note: PublishedNote): Promise<TargetOutcome[]> {
    const outcomes: TargetOutcome[] = [];

    const syncs: PublishedNote["syncs"] = {};
    // The version every target gets is the file as it is now; its mtime tells a later edit apart.
    const editedAt = (await vaultShareSource().freshness(note)).editedAt ?? new Date().toISOString();

    for (const target of targets) {
        const driver = driverFor(target);

        try {
            await driver.sync(target, note);
            outcomes.push({ target: target.name, url: await driver.pageUrl(target, note.slug) });
            syncs[target.name] = { syncedAt: new Date().toISOString(), sourceModifiedAt: editedAt };
        } catch (err) {
            log.warn({ err, target: target.name, slug: note.slug }, "share target sync failed");
            outcomes.push({ target: target.name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    const reached = outcomes.filter((outcome) => !outcome.error).map((outcome) => outcome.target);
    await setPublishedTargets(note.slug, { targets: [...note.targets, ...reached], syncs });

    return outcomes;
}

/** The UI publish button: send the note to the default target without making the page wait; failures are logged. */
export function shareInBackground(note: PublishedNote): void {
    void (async () => {
        const { share } = await getConfig();
        await sendTo(resolveTargets(share, []), note);
    })().catch((err: unknown) => {
        log.warn({ err, slug: note.slug }, "background share failed");
    });
}

/** The UI unpublish button: the note is already unpublished; take it off the targets it was sent to. */
export function unshareInBackground(note: PublishedNote): void {
    void (async () => {
        const { share } = await getConfig();

        for (const target of share.targets.filter((entry) => note.targets.includes(entry.name))) {
            await driverFor(target).remove(target, note.slug);
        }
    })().catch((err: unknown) => {
        log.warn({ err, slug: note.slug }, "background unshare failed; `share sync --prune` removes it later");
    });
}

/** Publish a vault note and send it to the targets `names` picks. */
export async function shareToTargets(options: {
    vaultPath: string;
    targetNames: readonly string[];
}): Promise<{ note: PublishedNote; outcomes: TargetOutcome[] }> {
    const { share } = await getConfig();
    const targets = resolveTargets(share, options.targetNames);
    const note = await publishNote(options.vaultPath);

    return { note, outcomes: await sendTo(targets, note) };
}

/**
 * Send published notes again: the given slugs, or every published note. With no target names each note goes to the
 * targets it was sent to before; with names, to those targets.
 */
export async function syncShares(options: {
    slugs: readonly string[];
    all: boolean;
    targetNames: readonly string[];
}): Promise<Array<{ note: PublishedNote; outcomes: TargetOutcome[] }>> {
    const { share, publishedNotes } = await getConfig();
    const notes = options.all ? publishedNotes : publishedNotes.filter((note) => options.slugs.includes(note.slug));
    const missing = options.slugs.filter((slug) => !publishedNotes.some((note) => note.slug === slug));

    if (missing.length > 0) {
        throw new Error(`not published: ${missing.join(", ")}`);
    }

    const results: Array<{ note: PublishedNote; outcomes: TargetOutcome[] }> = [];

    for (const note of notes) {
        const targets =
            options.targetNames.length > 0
                ? resolveTargets(share, options.targetNames)
                : share.targets.filter((target) => note.targets.includes(target.name));
        results.push({ note, outcomes: await sendTo(targets, note) });
    }

    return results;
}

/**
 * Remove folders a target holds for notes that are no longer published there (an unshare while it was offline).
 * Returns the slugs removed per target; a driver that cannot list is skipped.
 */
export async function pruneTargets(
    targetNames: readonly string[]
): Promise<Array<{ target: string; removed: string[] }>> {
    const { share } = await getConfig();
    const published = await listPublished();
    const results: Array<{ target: string; removed: string[] }> = [];

    for (const target of resolveTargets(share, targetNames.length > 0 ? targetNames : [ALL_TARGETS])) {
        const driver = driverFor(target);
        const held = await driver.listSlugs(target);

        if (held === null) {
            continue;
        }

        const keep = new Set(published.filter((note) => note.targets.includes(target.name)).map((note) => note.slug));
        const stale = held.filter((slug) => !keep.has(slug));

        for (const slug of stale) {
            await driver.remove(target, slug);
        }

        results.push({ target: target.name, removed: stale });
    }

    return results;
}

/**
 * Take a note off targets. With target names, only those (the note stays published elsewhere); without, off every
 * target it was sent to, and unpublished on the Mac too.
 */
export async function unshareFromTargets(options: {
    slug: string;
    targetNames: readonly string[];
}): Promise<TargetOutcome[]> {
    const { share } = await getConfig();
    const note = await findPublishedBySlug(options.slug);

    if (!note) {
        throw new Error(`not published: ${options.slug}`);
    }

    const everything = options.targetNames.length === 0;
    const targets = everything
        ? share.targets.filter((target) => note.targets.includes(target.name))
        : resolveTargets(share, options.targetNames);
    const outcomes: TargetOutcome[] = [];

    for (const target of targets) {
        try {
            await driverFor(target).remove(target, note.slug);
            outcomes.push({ target: target.name });
        } catch (err) {
            log.warn({ err, target: target.name, slug: note.slug }, "share target removal failed");
            outcomes.push({ target: target.name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    const removed = new Set(outcomes.filter((outcome) => !outcome.error).map((outcome) => outcome.target));

    if (everything && removed.size === targets.length) {
        await unpublishNote(note.slug);
    } else {
        await setPublishedTargets(note.slug, { targets: note.targets.filter((name) => !removed.has(name)) });
    }

    return outcomes;
}
