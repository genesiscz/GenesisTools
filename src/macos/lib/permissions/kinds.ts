import { isPermissionKind, type PermissionKindId } from "@genesiscz/utils/macos/permission-kinds";

export { isPermissionKind, PERMISSION_KINDS, type PermissionKindId } from "@genesiscz/utils/macos/permission-kinds";

/** `--permission-status` prints one wire value (GenesisKit PermissionStatus.wireValue); this is its reading. */
export function permissionStatusLabel(wire: string): string {
    const value = wire.trim();

    if (value === "notDetermined") {
        return "not asked yet";
    }

    if (value.startsWith("partial:") || value.startsWith("unknown:")) {
        return value.slice(value.indexOf(":") + 1);
    }

    return value || "no answer";
}

/**
 * `GenesisTools --permission-status all` prints one `<kind> <wire value>` line per grant; this is the table of them.
 * A line of a kind this list does not know (a newer app) is dropped.
 */
export function parsePermissionStatusLines(text: string): Map<PermissionKindId, string> {
    const statuses = new Map<PermissionKindId, string>();

    for (const line of text.split("\n")) {
        const [kind, ...wire] = line.trim().split(" ");
        if (kind && wire.length > 0 && isPermissionKind(kind)) {
            statuses.set(kind, wire.join(" "));
        }
    }

    return statuses;
}
