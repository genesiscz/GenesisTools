import type { PublishedNote } from "@app/dev-dashboard/config";
import type { ShareTargetStatusDto } from "@app/dev-dashboard/contract/endpoints";
import { legacyPublication, loadSharePublishConfig } from "@app/dev-dashboard/lib/share/legacy-share";
import { findPublication } from "@genesiscz/utils/genesis-tools/publish/store";
import { transportFor } from "@genesiscz/utils/publish/transports";

export async function shareStatusFor(note: PublishedNote): Promise<ShareTargetStatusDto[]> {
    const [config, publication] = await Promise.all([
        loadSharePublishConfig(),
        findPublication({ kind: "md", id: note.slug }),
    ]);
    const syncs = publication?.syncs ?? legacyPublication(note).syncs;
    const rows: ShareTargetStatusDto[] = [];

    for (const target of config.targets) {
        const driver = transportFor(target);
        const sync = Object.hasOwn(syncs, target.name) ? syncs[target.name] : undefined;
        if (!driver.live && !sync) {
            continue;
        }

        const url = driver.pageUrl({ target, kind: "md", id: note.slug });
        if (!url) {
            continue;
        }

        rows.push({
            target: target.name,
            driver: driver.kind,
            live: driver.live,
            isDefault: target.name === config.defaults.target,
            url,
            syncedAt: driver.live ? null : (sync?.syncedAt ?? null),
            sourceModifiedAt: driver.live ? null : (sync?.sourceModifiedAt ?? null),
        });
    }

    return rows.sort((a, b) => Number(b.live) - Number(a.live) || Number(b.isDefault) - Number(a.isDefault));
}
