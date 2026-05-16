import { randomBytes } from "node:crypto";
import { getConfig, type PublishedNote, saveConfig } from "@app/dev-dashboard/config";

function makeSlug(): string {
    return randomBytes(12).toString("base64url");
}

export async function publishNote(vaultPath: string): Promise<PublishedNote> {
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
}

export async function unpublishNote(slug: string): Promise<void> {
    const config = await getConfig();
    await saveConfig({ ...config, publishedNotes: config.publishedNotes.filter((note) => note.slug !== slug) });
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
