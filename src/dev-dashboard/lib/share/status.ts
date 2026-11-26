import type { PublishedNote } from "@app/dev-dashboard/config";
import type { ShareTargetStatusDto } from "@app/dev-dashboard/contract/endpoints";
import { driverFor } from "@app/dev-dashboard/lib/share/drivers";
import type { ShareConfig } from "@app/dev-dashboard/lib/share/drivers/options";

/**
 * Where a published note is served, for the reader: every live target (it serves every published note), then each
 * target the note was synced to, with its last sync. The default target comes first within each group.
 */
export async function shareStatusFor(note: PublishedNote, share: ShareConfig): Promise<ShareTargetStatusDto[]> {
    const held = share.targets.filter((target) => driverFor(target).live || note.targets.includes(target.name));
    const ordered = [...held].sort(
        (a, b) =>
            Number(driverFor(b).live) - Number(driverFor(a).live) ||
            Number(b.name === share.defaults.target) - Number(a.name === share.defaults.target)
    );

    return Promise.all(
        ordered.map(async (target) => {
            const driver = driverFor(target);
            const sync = note.syncs[target.name];

            return {
                target: target.name,
                driver: target.driver,
                live: driver.live,
                isDefault: target.name === share.defaults.target,
                url: await driver.pageUrl(target, note.slug),
                syncedAt: driver.live ? null : (sync?.syncedAt ?? null),
                sourceModifiedAt: driver.live ? null : (sync?.sourceModifiedAt ?? null),
            };
        })
    );
}
