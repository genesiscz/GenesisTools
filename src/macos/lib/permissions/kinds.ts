/**
 * The grants `GenesisTools --permission-dialog <kind>` and `--permission-status <kind>` take: the raw values of
 * GenesisKit's PermissionKind (src/macos/GenesisKit/Sources/GenesisKitBase/Permissions/PermissionKind.swift). A test keeps
 * the two lists equal.
 */
export const PERMISSION_KINDS = [
    "input-monitoring",
    "accessibility",
    "microphone",
    "camera",
    "speech",
    "screen-recording",
    "calendar",
    "reminders",
    "contacts",
    "full-disk-access",
    "automation",
    "desktop",
    "documents",
    "downloads",
    "local-network",
] as const;

export type PermissionKindId = (typeof PERMISSION_KINDS)[number];

export function isPermissionKind(value: string): value is PermissionKindId {
    return (PERMISSION_KINDS as readonly string[]).includes(value);
}

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
