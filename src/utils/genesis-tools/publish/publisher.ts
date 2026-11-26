import { rm } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import { makeTempDir } from "@genesiscz/utils/paths";
import { auditClientOperation } from "../../publish/audit";
import type { SyncRecord } from "../../publish/freshness";
import { isSnapshotId, newSnapshotId } from "../../publish/ids";
import type { PublishedKind } from "../../publish/kind";
import { checkSnapshotDir } from "../../publish/snapshot-store";
import { ALL_TARGETS, resolveTargets, targetDestination } from "../../publish/targets";
import { transportFor } from "../../publish/transports";
import {
    findPublication,
    forgetPublication,
    listPublications,
    loadShareConfig,
    type Publication,
    savePublication,
    withPublicationLock,
} from "./store";

const { log } = logger.scoped("publisher");

export interface TargetOutcome {
    target: string;
    url?: string;
    error?: string;
}

export interface PublishInput {
    id?: string;
    source: string;
    title: string;
    sourceModifiedAt?: string;
    sourceInputs?: Array<{ path: string; hash: string }>;
    sourceFingerprint?: string;
    targetNames: readonly string[];
    build(input: { dir: string; id: string }): Promise<void>;
}

export interface PublishResult {
    id: string;
    outcomes: TargetOutcome[];
}

export interface Publisher {
    publish(input: PublishInput): Promise<PublishResult>;
    unpublish(input: { id: string; targetNames: readonly string[] }): Promise<TargetOutcome[]>;
    prune(targetNames: readonly string[]): Promise<Array<{ target: string; removed: string[] }>>;
    list(): Promise<Publication[]>;
    find(input: { id?: string; source?: string }): Promise<Publication | undefined>;
}

export function publisher(kind: PublishedKind): Publisher {
    return {
        publish: (input) =>
            auditClientOperation(
                { action: "publish", kind: kind.id, id: input.id },
                () => withPublicationLock(kind.id, () => publish(kind, input)),
                (result) => ({ id: result.id, status: result.outcomes.some((outcome) => outcome.error) ? 207 : 200 })
            ),
        unpublish: (input) => withPublicationLock(kind.id, () => unpublish(kind.id, input)),
        prune: (names) =>
            auditClientOperation({ action: "prune", kind: kind.id }, () =>
                withPublicationLock(kind.id, () => prune(kind.id, names))
            ),
        list: () => listPublications(kind.id),
        find: (input) => findPublication({ kind: kind.id, ...input }),
    };
}

async function publish(kind: PublishedKind, input: PublishInput): Promise<PublishResult> {
    const config = await loadShareConfig();
    const targets = resolveTargets({
        targets: config.targets,
        defaultTarget: config.defaults.target,
        names: input.targetNames,
    });
    const previous = await findPublication(
        input.id === undefined ? { kind: kind.id, source: input.source } : { kind: kind.id, id: input.id }
    );
    const id = input.id ?? previous?.id ?? newSnapshotId();
    if (!isSnapshotId(id)) {
        throw new Error(`Invalid snapshot id: ${id}`);
    }

    const at = new Date().toISOString();
    const outcomes: TargetOutcome[] = [];
    if (!targets.length) {
        return { id, outcomes };
    }

    const dir = makeTempDir("publish-snapshot-");
    const synced: Array<[string, SyncRecord]> = [];
    try {
        await input.build({ dir, id });
        const check = await checkSnapshotDir({ kind, id, dir });
        if (!check.ok) {
            throw new Error(check.error);
        }

        for (const target of targets) {
            const transport = transportFor(target);
            try {
                const location = { target, kind: kind.id, id };
                const url = transport.pageUrl(location);
                if (!url) {
                    throw new Error(`Target does not serve ${kind.title} publications`);
                }

                await auditClientOperation({ action: "send", target: target.name, kind: kind.id, id }, () =>
                    transport.send({ ...location, dir, maxUploadBytes: kind.maxUploadBytes })
                );
                outcomes.push({ target: target.name, url });
                synced.push([
                    target.name,
                    {
                        syncedAt: new Date().toISOString(),
                        sourceModifiedAt: input.sourceModifiedAt ?? at,
                        sourceFingerprint: input.sourceFingerprint,
                    },
                ]);
            } catch (err) {
                log.warn({ err, target: target.name, kind: kind.id, id }, "publication send failed");
                outcomes.push({ target: target.name, error: err instanceof Error ? err.message : String(err) });
            }
        }

        if (synced.length > 0) {
            await savePublication({
                kind: kind.id,
                id,
                title: input.title,
                source: input.source,
                sourceInputs: input.sourceInputs,
                publishedAt: previous?.publishedAt ?? at,
                syncs: { ...previous?.syncs, ...Object.fromEntries(synced) },
            });
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }

    return { id, outcomes };
}

async function unpublish(
    kind: string,
    input: { id: string; targetNames: readonly string[] }
): Promise<TargetOutcome[]> {
    const { id, targetNames } = input;
    const entry = await findPublication({ kind, id });
    const config = await loadShareConfig();
    const everything = targetNames.length === 0;
    const targets = everything
        ? config.targets.filter((target) => entry?.syncs && Object.hasOwn(entry.syncs, target.name))
        : resolveTargets({ targets: config.targets, names: targetNames });
    const outcomes: TargetOutcome[] = [];
    if (everything && entry) {
        const configured = new Set(config.targets.map((target) => target.name));
        for (const name of Object.keys(entry.syncs)) {
            if (!configured.has(name)) {
                outcomes.push({
                    target: name,
                    error: `Target "${name}" is no longer configured; its remote snapshot was not removed`,
                });
            }
        }
    }

    const removed = new Set<string>();
    for (const target of targets) {
        try {
            await auditClientOperation({ action: "remove", target: target.name, kind, id }, () =>
                transportFor(target).remove({ target, kind, id })
            );
            removed.add(target.name);
            outcomes.push({ target: target.name });
        } catch (err) {
            log.warn({ err, target: target.name, kind, id }, "publication removal failed");
            outcomes.push({ target: target.name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    if (entry) {
        const remaining = Object.entries(entry.syncs).filter(([name]) => !removed.has(name));
        if (remaining.length) {
            await savePublication({ ...entry, syncs: Object.fromEntries(remaining) });
        } else {
            await forgetPublication({ kind, id });
        }
    }

    return outcomes;
}

async function prune(kind: string, names: readonly string[]): Promise<Array<{ target: string; removed: string[] }>> {
    const config = await loadShareConfig();
    const entries = await listPublications(kind);
    const targets = resolveTargets({ targets: config.targets, names: names.length ? names : [ALL_TARGETS] });
    const result: Array<{ target: string; removed: string[] }> = [];
    for (const target of targets) {
        const transport = transportFor(target);
        const held = await transport.list({ target, kind });
        if (held === null) {
            continue;
        }

        const destination = targetDestination(target);
        const aliases = config.targets.filter((other) => targetDestination(other) === destination);
        const keep = new Set(
            entries
                .filter((entry) => aliases.some((alias) => Object.hasOwn(entry.syncs, alias.name)))
                .map((entry) => entry.id)
        );
        const stale = held.filter((id) => !keep.has(id));
        for (const id of stale) {
            await auditClientOperation({ action: "remove", target: target.name, kind, id }, () =>
                transport.remove({ target, kind, id })
            );
        }

        result.push({ target: target.name, removed: stale });
    }

    return result;
}
