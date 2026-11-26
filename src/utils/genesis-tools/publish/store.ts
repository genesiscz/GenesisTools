import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { jsonDocument, prettyJson } from "@genesiscz/utils/storage/locked-document";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import type { SyncRecord } from "../../publish/freshness";
import { isSnapshotId, KIND_ID_RE } from "../../publish/ids";
import { type PublishTarget, PublishTargetSchema, TARGET_NAME_RE } from "../../publish/targets";

export interface PublishConfig {
    version: 1;
    client: { defaults: { target?: string }; targets: PublishTarget[] };
}

export interface Publication {
    kind: string;
    id: string;
    title: string;
    source: string;
    publishedAt: string;
    syncs: Record<string, SyncRecord>;
}

export const PublishConfigSchema: z.ZodType<PublishConfig> = z.object({
    version: z.literal(1),
    client: z.object({
        defaults: z.object({ target: z.string().regex(TARGET_NAME_RE).optional() }),
        targets: z.array(PublishTargetSchema).superRefine((targets, ctx) => {
            const names = new Set<string>();
            for (const [index, target] of targets.entries()) {
                if (names.has(target.name)) {
                    ctx.addIssue({
                        code: "custom",
                        path: [index, "name"],
                        message: `Duplicate target "${target.name}"`,
                    });
                }

                names.add(target.name);
            }
        }),
    }),
});

export const PublicationSchema: z.ZodType<Publication> = z.object({
    kind: z.string().regex(KIND_ID_RE),
    id: z.string().refine(isSnapshotId),
    title: z.string(),
    source: z.string(),
    publishedAt: z.string(),
    syncs: z.record(
        z.string().regex(TARGET_NAME_RE),
        z.object({
            syncedAt: z.string(),
            sourceModifiedAt: z.string(),
        })
    ),
});

const PublicationsSchema = z.object({ version: z.literal(1), publications: z.array(PublicationSchema) });
type Publications = z.infer<typeof PublicationsSchema>;

function emptyConfig(): PublishConfig {
    return { version: 1, client: { defaults: {}, targets: [] } };
}

export function migratePublishConfig(raw: unknown): unknown {
    if (raw == null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) {
        return emptyConfig();
    }

    return raw;
}

export function publishConfigPath(): string {
    return toolDataDir("publish", "config.json");
}

export function publicationsPath(): string {
    return toolDataDir("publish", "publications.json");
}

function configDocument() {
    return jsonDocument({
        path: publishConfigPath(),
        empty: emptyConfig,
        decode: (raw) => PublishConfigSchema.parse(migratePublishConfig(raw)),
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "refuse",
        fileMode: 0o600,
        dirMode: 0o700,
    });
}

function publicationsDocument() {
    return jsonDocument({
        path: publicationsPath(),
        empty: (): Publications => ({ version: 1, publications: [] }),
        decode: (raw) => PublicationsSchema.parse(raw),
        encode: prettyJson,
        strictJson: true,
        onUnreadable: "refuse",
        fileMode: 0o600,
        dirMode: 0o700,
    });
}

export function loadPublishConfig(): Promise<PublishConfig> {
    return configDocument().readAsync();
}

export function updatePublishConfig(change: (config: PublishConfig) => PublishConfig): Promise<PublishConfig> {
    return configDocument().update((current) => {
        const next = PublishConfigSchema.parse(change(current));
        return { write: next, result: next };
    });
}

export async function listPublications(kind?: string): Promise<Publication[]> {
    const { publications } = await publicationsDocument().readAsync();
    return kind === undefined ? publications : publications.filter((entry) => entry.kind === kind);
}

export async function findPublication(input: {
    kind: string;
    id?: string;
    source?: string;
}): Promise<Publication | undefined> {
    if (input.id === undefined && input.source === undefined) {
        return undefined;
    }

    return (await listPublications(input.kind)).find(
        (entry) =>
            (input.id === undefined || entry.id === input.id) &&
            (input.source === undefined || entry.source === input.source)
    );
}

export async function savePublication(entry: Publication): Promise<void> {
    const saved = PublicationSchema.parse(entry);
    await publicationsDocument().mutate((doc) => {
        const index = doc.publications.findIndex(({ kind, id }) => kind === saved.kind && id === saved.id);
        if (index >= 0) {
            doc.publications[index] = saved;
        } else {
            doc.publications.push(saved);
        }
    });
}

export async function forgetPublication(input: { kind: string; id: string }): Promise<void> {
    await publicationsDocument().mutate((doc) => {
        doc.publications = doc.publications.filter(({ kind, id }) => kind !== input.kind || id !== input.id);
    });
}

/** Serializes a kind's network sends, removals and ledger updates across CLI and dashboard processes. */
export function withPublicationLock<T>(kind: string, run: () => Promise<T>): Promise<T> {
    if (!KIND_ID_RE.test(kind)) {
        throw new Error(`Invalid published kind: ${kind}`);
    }

    return withFileLock(toolDataDir("publish", `.${kind}.lock`), run, 300_000);
}
