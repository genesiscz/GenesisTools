import { getConfig, type PublishedNote, saveConfig, withConfigMutation } from "@app/dev-dashboard/config";
import { newSnapshotId } from "@genesiscz/utils/publish/ids";

export function publishNote(input: string): Promise<PublishedNote> {
    const vaultPath = input.normalize("NFC");
    return withConfigMutation(async () => {
        const config = await getConfig();
        const existing = config.publishedNotes.find((note) => note.vaultPath === vaultPath);

        if (existing) {
            return existing;
        }

        let slug = newSnapshotId();

        while (config.publishedNotes.some((note) => note.slug === slug)) {
            slug = newSnapshotId();
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

    const wanted = vaultPath.normalize("NFC");

    return config.publishedNotes.find((note) => note.vaultPath === wanted);
}

export async function listPublished(): Promise<PublishedNote[]> {
    const config = await getConfig();

    return config.publishedNotes;
}
