import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { type PublishResult, publisher, type TargetOutcome } from "@genesiscz/utils/genesis-tools/publish/publisher";
import { loadShareConfig, type Publication } from "@genesiscz/utils/genesis-tools/publish/store";
import { shareServerSetupCommand } from "@genesiscz/utils/genesis-tools/tools/publish";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { makeTempDir } from "@genesiscz/utils/paths";
import { isEditedAfterSync } from "@genesiscz/utils/publish/freshness";
import { ARTIFACT_ENTRY, artifactKind, writeArtifactSnapshot } from "@genesiscz/utils/publish/kinds/artifact";
import { resolveTargets } from "@genesiscz/utils/publish/targets";
import { transportFor } from "@genesiscz/utils/publish/transports";
import { buildSingleFile, embedScopeFor, resolveEntry } from "./build";
import { resolveTarget } from "./registry";

const artifacts = publisher(artifactKind);

function fingerprint(inputs: Array<{ path: string; hash: string }>): string {
    return createHash("sha256").update(SafeJSON.stringify(inputs)).digest("hex");
}

export async function publishArtifact(input: {
    target?: string;
    entry?: string;
    title?: string;
    targetNames: string[];
}): Promise<PublishResult> {
    const config = await loadShareConfig();
    const targets = resolveTargets({
        targets: config.targets,
        defaultTarget: config.defaults.target,
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

    const buildDir = makeTempDir("artifact-publication-");
    try {
        const result = await buildSingleFile({
            dir: resolved.dir,
            entry,
            out: join(buildDir, ARTIFACT_ENTRY),
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

        return await artifacts.publish({
            source,
            title,
            sourceModifiedAt,
            sourceInputs: result.sourceInputs,
            sourceFingerprint: fingerprint(result.sourceInputs),
            targetNames: input.targetNames,
            build: async ({ dir, id }) => {
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
    } finally {
        await rm(buildDir, { recursive: true, force: true });
    }
}

export async function unpublishArtifact(input: {
    idOrTarget: string;
    entry?: string;
    targetNames: string[];
}): Promise<TargetOutcome[]> {
    const byId = await artifacts.find({ id: input.idOrTarget });
    if (byId) {
        return artifacts.unpublish({ id: byId.id, targetNames: input.targetNames });
    }

    const target = resolveTarget(input.idOrTarget);
    const entry = resolveEntry(target.dir, input.entry ?? target.entry ?? target.registryEntry?.entry);
    const publication = await artifacts.find({ source: resolve(target.dir, entry) });
    if (!publication) {
        throw new Error(`No publication found for ${input.idOrTarget}`);
    }

    return artifacts.unpublish({ id: publication.id, targetNames: input.targetNames });
}

export async function listPublishedArtifacts(): Promise<Array<Publication & { stale: boolean }>> {
    const publications = await artifacts.list();
    const rows: Array<Publication & { stale: boolean }> = [];
    for (const publication of publications) {
        const source = await stat(publication.source).catch((err: unknown) => {
            logger.debug({ err, source: publication.source }, "artifact source has no readable mtime");
            return undefined;
        });
        const editedAt = source?.mtime.toISOString();
        let stale =
            !source ||
            !publication.sourceInputs ||
            Object.values(publication.syncs).some((sync) => isEditedAfterSync(editedAt, sync));
        const currentInputs: Array<{ path: string; hash: string }> = [];
        for (const input of publication.sourceInputs ?? []) {
            try {
                const hash = createHash("sha256")
                    .update(await readFile(input.path))
                    .digest("hex");
                currentInputs.push({ path: input.path, hash });
                if (hash !== input.hash) {
                    stale = true;
                    break;
                }
            } catch (err) {
                logger.debug({ err, source: input.path }, "artifact build input is unavailable");
                stale = true;
                break;
            }
        }
        const currentFingerprint = fingerprint(currentInputs);
        stale ||= Object.values(publication.syncs).some((sync) => sync.sourceFingerprint !== currentFingerprint);
        rows.push({ ...publication, stale });
    }

    return rows;
}
