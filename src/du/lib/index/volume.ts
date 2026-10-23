import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ module: "du-index-volume" });

/** What identifies the volume an index was built on: the walker's `statfs` fsid and the APFS volume UUID. */
export interface VolumeIdentity {
    fsid: string | null;
    uuid: string | null;
}

/**
 * Whether a walk is on the volume the index was built on.
 *
 * The fsid alone is not stable: macOS hands a volume a new device number when it mounts in another
 * order, so after a reboot the boot volume's fsid changed (0100000e… vs 01000010…) and every update
 * failed with `volume_changed` for six days (2026-10-17 to 2026-10-23). The volume UUID survives a
 * remount, so it decides whenever both sides have one. An index written before the UUID was stored
 * keeps the path as its only other evidence, so a moved fsid with a readable UUID is accepted once
 * and the caller stores that UUID.
 */
export function sameVolume(known: VolumeIdentity, current: VolumeIdentity): boolean {
    if (known.uuid && current.uuid) {
        return known.uuid === current.uuid;
    }

    if (!known.fsid || !current.fsid || known.fsid === current.fsid) {
        return true;
    }

    return known.uuid === null && current.uuid !== null;
}

/** The APFS/HFS volume UUID of the volume holding `path`, or null when macOS does not report one. */
export function volumeUuidAt(path: string): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    const df = Bun.spawnSync(["/bin/df", "-P", path], { stderr: "pipe" });
    const mount = df.stdout.toString().trim().split("\n").at(-1)?.split(/\s+/).slice(5).join(" ");
    if (df.exitCode !== 0 || !mount) {
        log.warn({ path, stderr: df.stderr.toString().trim() }, "df could not name the mount point");
        return null;
    }

    const info = Bun.spawnSync(["/usr/sbin/diskutil", "info", "-plist", mount], { stderr: "pipe" });
    const match = info.stdout.toString().match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/);
    if (info.exitCode !== 0 || !match) {
        log.warn({ path, mount, stderr: info.stderr.toString().trim() }, "diskutil reported no volume UUID");
        return null;
    }

    return match[1];
}
