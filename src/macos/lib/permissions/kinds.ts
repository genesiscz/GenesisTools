/**
 * The grants `GenesisTools --permission-dialog <kind>` and `--permission-status <kind>` take: the raw values of
 * GenesisKit's PermissionKind (src/macos/GenesisKit/Sources/GenesisKit/Permissions/PermissionKind.swift). A test keeps
 * the two lists equal.
 */
export const PERMISSION_KINDS = [
    "input-monitoring",
    "accessibility",
    "microphone",
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
