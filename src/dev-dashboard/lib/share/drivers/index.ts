import { macLiveDriver } from "@app/dev-dashboard/lib/share/drivers/mac-live/driver";
import type { ShareDriverKind, ShareTarget } from "@app/dev-dashboard/lib/share/drivers/options";
import { pairedDriver } from "@app/dev-dashboard/lib/share/drivers/paired/driver";
import { sshRsyncDriver } from "@app/dev-dashboard/lib/share/drivers/ssh-rsync/driver";
import type { ShareDriver } from "@app/dev-dashboard/lib/share/drivers/types";

/** Every driver, by kind. The mapped type makes a new kind in `options.ts` fail here until it has a driver. */
export const SHARE_DRIVERS: { readonly [K in ShareDriverKind]: ShareDriver & { readonly kind: K } } = {
    "mac-live": { ...macLiveDriver, kind: "mac-live" },
    paired: { ...pairedDriver, kind: "paired" },
    "ssh-rsync": { ...sshRsyncDriver, kind: "ssh-rsync" },
};

export function isShareDriverKind(value: string): value is ShareDriverKind {
    return Object.hasOwn(SHARE_DRIVERS, value);
}

export const SHARE_DRIVER_KINDS: ShareDriverKind[] = Object.keys(SHARE_DRIVERS).filter(isShareDriverKind);

export function driverFor(target: ShareTarget): ShareDriver {
    return SHARE_DRIVERS[target.driver];
}
