import {
    getConfig,
    LegacyShareSourceSchema,
    type PublishedNote,
    saveConfig,
    withConfigMutation,
} from "@app/dev-dashboard/config";
import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";
import { shareTitle } from "@app/dev-dashboard/lib/share/source";
import {
    findPublication,
    loadShareConfig,
    type Publication,
    type ShareConfig,
    savePublication,
    updateShareConfig,
    withPublicationLock,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { originOf } from "@genesiscz/utils/publish/ids";
import { type PublishTarget, PublishTargetSchema } from "@genesiscz/utils/publish/targets";

export interface LegacyShareImport {
    targets: PublishTarget[];
    defaultTarget?: string;
    publications: Publication[];
}

function liveTarget(name: string, base: string): PublishTarget {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    return PublishTargetSchema.parse({
        name,
        publicBase: originOf(base),
        transport: { kind: "mac-live", mounts: { md: path || "/share" } },
    });
}

export function legacyPublication(note: PublishedNote): Publication {
    const names = new Set([...(note.targets ?? []), ...Object.keys(note.syncs ?? {})]);
    const fallback = { syncedAt: note.publishedAt, sourceModifiedAt: note.publishedAt };
    return {
        kind: "md",
        id: note.slug,
        title: shareTitle(note.vaultPath),
        source: note.vaultPath,
        publishedAt: note.publishedAt,
        syncs: Object.fromEntries(
            [...names].map((name) => [
                name,
                note.syncs && Object.hasOwn(note.syncs, name) ? note.syncs[name] : fallback,
            ])
        ),
    };
}

export function legacyShareImport(input: { rawConfig: unknown; livePublicBase: string }): LegacyShareImport | null {
    const { share, publishedNotes } = LegacyShareSourceSchema.parse(input.rawConfig ?? {});
    const notes = publishedNotes.filter((note) => note.targets !== undefined || note.syncs !== undefined);
    if (!share && notes.length === 0) {
        return null;
    }

    const targets = (share?.targets ?? []).map((target) => {
        if (target.driver === "mac-live") {
            return liveTarget(target.name, target.publicBase ?? input.livePublicBase);
        }

        if (target.driver === "paired") {
            const { name, url, deviceId, token } = target;
            return PublishTargetSchema.parse({
                name,
                publicBase: originOf(target.publicBase ?? url),
                transport: { kind: "paired", url: originOf(url), deviceId, token },
            });
        }

        const { name, driver: kind, host, dataDir, publicBase } = target;
        return PublishTargetSchema.parse({
            name,
            publicBase: originOf(publicBase),
            transport: { kind, host, dataDir },
        });
    });

    return { targets, defaultTarget: share?.defaults.target, publications: notes.map(legacyPublication) };
}

function mergeConfig(config: ShareConfig, legacy: LegacyShareImport | null, base: string): ShareConfig {
    const byName = new Map(config.targets.map((target) => [target.name, target]));
    const targets = legacy?.targets ?? [];
    for (const target of targets) {
        if (!byName.has(target.name)) {
            byName.set(target.name, target);
        }
    }

    let defaultTarget = config.defaults.target ?? legacy?.defaultTarget;
    if (byName.size === 0 && legacy?.defaultTarget === undefined) {
        byName.set("mac", liveTarget("mac", base));
        defaultTarget = "mac";
    }

    return { ...config, defaults: { ...config.defaults, target: defaultTarget }, targets: [...byName.values()] };
}

/** The dashboard keeps showing its existing targets before the first write imports them. */
export async function loadSharePublishConfig(): Promise<ShareConfig> {
    const [rawConfig, config, livePublicBase] = await Promise.all([getConfig(), loadShareConfig(), publicBaseUrl()]);
    return mergeConfig(config, legacyShareImport({ rawConfig, livePublicBase }), livePublicBase);
}

export async function importLegacyShare(): Promise<{ imported: string[] }> {
    return withConfigMutation(async () => {
        const rawConfig = await getConfig();
        const livePublicBase = await publicBaseUrl();
        const legacy = legacyShareImport({ rawConfig, livePublicBase });
        const config = await loadShareConfig();

        if (!legacy && config.targets.length > 0) {
            return { imported: [] };
        }

        const imported: string[] = [];
        await updateShareConfig((current) => {
            const merged = mergeConfig(current, legacy, livePublicBase);
            const existing = new Set(current.targets.map((target) => target.name));
            imported.push(
                ...merged.targets.filter((target) => !existing.has(target.name)).map((target) => target.name)
            );
            return merged;
        });

        if (legacy) {
            await withPublicationLock("md", async () => {
                for (const entry of legacy.publications) {
                    if (!(await findPublication({ kind: entry.kind, id: entry.id }))) {
                        await savePublication(entry);
                    }
                }

                const { share: _share, ...rest } = rawConfig;
                await saveConfig({
                    ...rest,
                    publishedNotes: rest.publishedNotes.map(({ targets: _targets, syncs: _syncs, ...note }) => note),
                });
            });
        }

        return { imported };
    });
}
