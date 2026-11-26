import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { type PublishResult, publisher, type TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
import { loadPublishConfig, type Publication } from "@genesiscz/utils/genesis-tools/publish/store";
import { shareServerSetupCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { logger } from "@genesiscz/utils/logger";
import { isEditedAfterSync } from "@genesiscz/utils/publish/freshness";
import { ARTIFACT_ENTRY, artifactKind, writeArtifactSnapshot } from "@genesiscz/utils/publish/kinds/artifact";
import { resolveTargets } from "@genesiscz/utils/publish/targets";
import { transportFor } from "@genesiscz/utils/publish/transports";
import { buildSingleFile, embedScopeFor, resolveEntry } from "./build";
import { resolveTarget } from "./registry";

const artifacts = publisher(artifactKind);

export async function publishArtifact(input: {
    target?: string;
    entry?: string;
    title?: string;
    targetNames: string[];
}): Promise<PublishResult> {
    const { client } = await loadPublishConfig();
    const targets = resolveTargets({
        targets: client.targets,
        defaultTarget: client.defaults.target,
        names: input.targetNames,
    });

    if (!targets.some((target) => transportFor(target).pageUrl({ target, kind: artifactKind.id, id: "preview" }))) {
        throw new Error(
            `No selected target serves artifacts. Run ${shareServerSetupCommand("client")} to add a paired target.`
        );
    }

    const resolved = resolveTarget(input.target);
    const entry = resolveEntry(resolved.dir, input.entry ?? resolved.entry ?? resolved.registryEntry?.entry);
    const source = resolve(resolved.dir, entry);
    const sourceName = basename(source);
    const title = input.title?.trim() || basename(source, extname(source));
    const sourceModifiedAt = (await stat(source)).mtime.toISOString();

    return artifacts.publish({
        source,
        title,
        sourceModifiedAt,
        targetNames: input.targetNames,
        build: async ({ dir, id }) => {
            const result = await buildSingleFile({
                dir: resolved.dir,
                entry,
                out: join(dir, ARTIFACT_ENTRY),
                embedScope: embedScopeFor({
                    fileTargetEntry: resolved.entry,
                    entryFlag: input.entry,
                    registryEntry: resolved.registryEntry?.entry,
                }),
            });
            for (const skip of result.skippedEmbeds) {
                logger.warn(
                    { file: skip.rel, reason: skip.reason, sizeBytes: skip.sizeBytes },
                    "artifact data file was not embedded"
                );
            }

            await writeArtifactSnapshot({
                dir,
                id,
                title,
                sourceName,
                sourceModifiedAt,
                html: await Bun.file(result.outPath).bytes(),
            });
        },
    });
}

export async function unpublishArtifact(input: {
    idOrTarget: string;
    targetNames: string[];
}): Promise<TargetOutcome[]> {
    const byId = await artifacts.find({ id: input.idOrTarget });
    if (byId) {
        return artifacts.unpublish({ id: byId.id, targetNames: input.targetNames });
    }

    const target = resolveTarget(input.idOrTarget);
    const entry = resolveEntry(target.dir, target.entry ?? target.registryEntry?.entry);
    const publication = await artifacts.find({ source: resolve(target.dir, entry) });
    if (!publication) {
        throw new Error(`No publication found for ${input.idOrTarget}`);
    }

    return artifacts.unpublish({ id: publication.id, targetNames: input.targetNames });
}

export async function listPublishedArtifacts(): Promise<Array<Publication & { stale: boolean }>> {
    const publications = await artifacts.list();
    return Promise.all(
        publications.map(async (publication) => {
            const source = await stat(publication.source).catch((err: unknown) => {
                logger.debug({ err, source: publication.source }, "artifact source has no readable mtime");
                return undefined;
            });
            const editedAt = source?.mtime.toISOString();
            const stale = Object.values(publication.syncs).some((sync) => isEditedAfterSync(editedAt, sync));
            return { ...publication, stale };
        })
    );
}
