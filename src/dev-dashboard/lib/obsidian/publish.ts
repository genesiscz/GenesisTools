import { randomBytes } from "node:crypto";
import { type DevDashboardConfig, getConfig, type PublishedNote, saveConfig } from "@app/dev-dashboard/config";

function makeSlug(): string {
    return randomBytes(12).toString("base64url");
}

// Serialize the read-modify-save sequence so two concurrent publishes can't
// each read the same config snapshot and clobber the other's published note.
let mutationChain: Promise<unknown> = Promise.resolve();

function withConfigMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutationChain.then(fn, fn);
    mutationChain = run.then(
        () => undefined,
        () => undefined
    );

    return run;
}

export function publishNote(vaultPath: string): Promise<PublishedNote> {
    return withConfigMutation(async () => {
        const config = await getConfig();
        const existing = config.publishedNotes.find((note) => note.vaultPath === vaultPath);

        if (existing) {
            return existing;
        }

        let slug = makeSlug();

        while (config.publishedNotes.some((note) => note.slug === slug)) {
            slug = makeSlug();
        }

        const note: PublishedNote = {
            slug,
            vaultPath,
            publishedAt: new Date().toISOString(),
            targets: [],
            syncs: {},
        };
        await saveConfig({ ...config, publishedNotes: [...config.publishedNotes, note] });

        return note;
    });
}

export function unpublishNote(slug: string): Promise<void> {
    return withConfigMutation(async () => {
        const config = await getConfig();
        await saveConfig({
            ...config,
            publishedNotes: config.publishedNotes.filter((note) => note.slug !== slug),
        });
    });
}

/**
 * Record which share targets hold the note, and the sends that just succeeded (`syncs`, merged by target). A target
 * that no longer holds the note loses its sync record. A slug that is no longer published is left alone.
 */
export function setPublishedTargets(
    slug: string,
    update: { targets: string[]; syncs?: PublishedNote["syncs"] }
): Promise<PublishedNote | undefined> {
    return withConfigMutation(async () => {
        const config = await getConfig();
        const note = config.publishedNotes.find((entry) => entry.slug === slug);

        if (!note) {
            return undefined;
        }

        const targets = [...new Set(update.targets)];
        const syncs = Object.fromEntries(
            Object.entries({ ...note.syncs, ...update.syncs }).filter(([name]) => targets.includes(name))
        );
        const next = { ...note, targets, syncs };
        await saveConfig({
            ...config,
            publishedNotes: config.publishedNotes.map((entry) => (entry.slug === slug ? next : entry)),
        });

        return next;
    });
}

/** Save the share settings (targets and the default target). */
export function saveShareConfig(share: DevDashboardConfig["share"]): Promise<void> {
    return withConfigMutation(async () => {
        const config = await getConfig();
        await saveConfig({ ...config, share });
    });
}

export async function findPublishedBySlug(slug: string): Promise<PublishedNote | undefined> {
    const config = await getConfig();

    return config.publishedNotes.find((note) => note.slug === slug);
}

export async function findPublishedByPath(vaultPath: string): Promise<PublishedNote | undefined> {
    const config = await getConfig();

    return config.publishedNotes.find((note) => note.vaultPath === vaultPath);
}

export async function listPublished(): Promise<PublishedNote[]> {
    const config = await getConfig();

    return config.publishedNotes;
}
