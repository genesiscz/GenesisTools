/**
 * `~/Library/Caches` entries that `app-bloat` reports with a finer rule (Playwright browsers, Electron ShipIt update
 * downloads). `system-caches` skips them, so one byte is never listed twice.
 */
export function isAppBloatCacheName(name: string): boolean {
    return name.startsWith("ms-playwright") || name.endsWith(".ShipIt");
}
