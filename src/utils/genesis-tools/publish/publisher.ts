import { rm } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";
import { makeTempDir } from "@genesiscz/utils/paths";
import type { SyncRecord } from "../../publish/freshness";
import { isSnapshotId, newSnapshotId } from "../../publish/ids";
import type { PublishedKind } from "../../publish/kind";
import { checkSnapshotDir } from "../../publish/snapshot-store";
import { ALL_TARGETS, resolveTargets } from "../../publish/targets";
import { transportFor } from "../../publish/transports";
import {
    findPublication,
    forgetPublication,
    listPublications,
    loadPublishConfig,
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
        publish: (input) => withPublicationLock(kind.id, () => publish(kind, input)),
        unpublish: (input) => withPublicationLock(kind.id, () => unpublish(kind.id, input)),
        prune: (names) => withPublicationLock(kind.id, () => prune(kind.id, names)),
        list: () => listPublications(kind.id),
        find: (input) => findPublication({ kind: kind.id, ...input }),
    };
}

async function publish(kind: PublishedKind, input: PublishInput): Promise<PublishResult> {
    const { client } = await loadPublishConfig();
    const targets = resolveTargets({ ...client, defaultTarget: client.defaults.target, names: input.targetNames });
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

                await transport.send({ ...location, dir });
                outcomes.push({ target: target.name, url });
                synced.push([
                    target.name,
                    { syncedAt: new Date().toISOString(), sourceModifiedAt: input.sourceModifiedAt ?? at },
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
    const { client } = await loadPublishConfig();
    const everything = targetNames.length === 0;
    const targets = everything
        ? client.targets.filter((target) => entry?.syncs && Object.hasOwn(entry.syncs, target.name))
        : resolveTargets({ targets: client.targets, names: targetNames });
    const outcomes: TargetOutcome[] = [];
    const removed = new Set<string>();
    for (const target of targets) {
        try {
            await transportFor(target).remove({ target, kind, id });
            removed.add(target.name);
            outcomes.push({ target: target.name });
        } catch (err) {
            log.warn({ err, target: target.name, kind, id }, "publication removal failed");
            outcomes.push({ target: target.name, error: err instanceof Error ? err.message : String(err) });
        }
    }

    if (entry) {
        const configured = new Set(client.targets.map((target) => target.name));
        const remaining = Object.entries(entry.syncs).filter(
            ([name]) => !removed.has(name) && (!everything || configured.has(name))
        );
        if (remaining.length) {
            await savePublication({ ...entry, syncs: Object.fromEntries(remaining) });
        } else {
            await forgetPublication({ kind, id });
        }
    }

    return outcomes;
}

async function prune(kind: string, names: readonly string[]): Promise<Array<{ target: string; removed: string[] }>> {
    const { client } = await loadPublishConfig();
    const entries = await listPublications(kind);
    const targets = resolveTargets({ targets: client.targets, names: names.length ? names : [ALL_TARGETS] });
    const result: Array<{ target: string; removed: string[] }> = [];
    for (const target of targets) {
        const transport = transportFor(target);
        const held = await transport.list({ target, kind });
        if (held === null) {
            continue;
        }

        const keep = new Set(
            entries.filter((entry) => Object.hasOwn(entry.syncs, target.name)).map((entry) => entry.id)
        );
        const stale = held.filter((id) => !keep.has(id));
        for (const id of stale) {
            await transport.remove({ target, kind, id });
        }

        result.push({ target: target.name, removed: stale });
    }

    return result;
}
