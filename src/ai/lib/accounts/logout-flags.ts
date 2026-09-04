import type { LogoutTarget } from "@genesiscz/utils/ai/providers/account-features";

/**
 * The logout flags every door shares. `--both` exists only on the claude door,
 * where it has meant "oauth + long-lived" since before the other providers had
 * accounts; it stays, because removing it would break a flag people type.
 */
export interface LogoutFlags {
    oauth?: boolean;
    longLived?: boolean;
    secondary?: boolean;
    authFile?: boolean;
    both?: boolean;
    all?: boolean;
}

/** Empty means "ask" (TTY) or "name a scope" (non-TTY); it never means "everything". */
export function logoutTargetsFromFlags(flags: LogoutFlags): LogoutTarget[] {
    if (flags.all) {
        return ["oauth", "longLived", "secondary", "authFile"];
    }

    const targets: LogoutTarget[] = [];

    if (flags.oauth || flags.both) {
        targets.push("oauth");
    }

    if (flags.longLived || flags.both) {
        targets.push("longLived");
    }

    if (flags.secondary) {
        targets.push("secondary");
    }

    if (flags.authFile) {
        targets.push("authFile");
    }

    return targets;
}
