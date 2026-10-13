import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";

const { log } = logger.scoped("chrome-devtools:permissions");
const prof = profiler.scope("chrome-devtools");

/**
 * Local Network Access permission names (Permissions API descriptors) as Chrome 145+ checks them: a public page
 * needs `local-network` for a private address (10.x, 192.168.x, a host that resolves there) and
 * `loopback-network` for 127.0.0.1 / localhost. The older `local-network-access` is only a query alias since 145
 * and unblocks nothing (measured on Chrome 154).
 */
export const LOCAL_NETWORK_PERMISSIONS = ["local-network", "loopback-network"] as const;

export interface PermissionGrant {
    name: string;
    granted: boolean;
    /** Chrome's refusal, e.g. "Invalid PermissionDescriptor name" or "can't be granted in current context". */
    error?: string;
}

/** Chrome grants these only to a secure origin: https, or http on localhost / 127.0.0.1 / [::1]. */
export function isSecureOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        return (
            url.protocol === "https:" ||
            (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        );
    } catch {
        return false;
    }
}

/**
 * Grants Permissions API names (descriptor names, kebab case) to `origin` in the tab's browser context. A grant
 * lives only as long as the CDP session that made it: Chrome drops it when that session detaches, so the caller
 * must stay attached while the page needs it. Each name reports its own result; nothing is swallowed.
 */
export async function grantPermissions(
    cdp: CdpLike,
    options: { origin: string; names: readonly string[] }
): Promise<PermissionGrant[]> {
    const stop = prof.start("permissions.grant");
    try {
        const info = (await cdp.send("Target.getTargetInfo", {})) as { targetInfo?: { browserContextId?: string } };
        const browserContextId = info.targetInfo?.browserContextId;
        const results: PermissionGrant[] = [];
        for (const name of options.names) {
            try {
                await cdp.send("Browser.setPermission", {
                    permission: { name },
                    setting: "granted",
                    origin: options.origin,
                    ...(browserContextId ? { browserContextId } : {}),
                });
                results.push({ name, granted: true });
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                log.debug({ name, origin: options.origin, error }, "permission grant refused");
                results.push({ name, granted: false, error });
            }
        }

        log.debug({ origin: options.origin, results }, "permissions granted for this session");
        return results;
    } finally {
        stop();
    }
}

/**
 * Why Local (or the older Private) Network Access stopped a failed request, else null. Chrome reports it in two
 * forms on `Network.loadingFailed`: a CORS error (`corsErrorStatus.corsError`, e.g.
 * `LocalNetworkAccessPermissionDenied`), or only the net error of a blocked preflight
 * (`net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, `net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS`).
 */
export function localNetworkBlockOf(loadingFailed: unknown): string | null {
    if (typeof loadingFailed !== "object" || loadingFailed === null) {
        return null;
    }

    const failed = loadingFailed as { corsErrorStatus?: { corsError?: unknown }; errorText?: unknown };
    const corsError = typeof failed.corsErrorStatus?.corsError === "string" ? failed.corsErrorStatus.corsError : null;
    if (corsError && /^(Local|Private)NetworkAccess/.test(corsError)) {
        return corsError;
    }

    const errorText = typeof failed.errorText === "string" ? failed.errorText : null;
    return errorText && /ERR_BLOCKED_BY_(LOCAL|PRIVATE)_NETWORK_ACCESS_CHECKS/.test(errorText) ? errorText : null;
}
