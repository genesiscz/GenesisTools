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
