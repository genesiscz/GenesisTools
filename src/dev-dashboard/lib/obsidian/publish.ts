import { randomBytes } from "node:crypto";
import { getConfig, type PublishedNote, saveConfig } from "@app/dev-dashboard/config";

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
