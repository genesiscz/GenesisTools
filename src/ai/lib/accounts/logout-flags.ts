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

/**
 * The scopes the flags NAMED. Empty means "ask" (TTY) or "name a scope"
 * (non-TTY); it never means "everything".
 *
 * `--all` is deliberately not expanded here. It means "every credential this
 * account holds", which only `runLogout` can know: expanding it to the four
 * declared kinds made `logout work --provider codex --all --yes` fail with "no
 * oauth credential" on an account that had never had one, and remove nothing
 * (PR #360 review t5).
 */
export function logoutTargetsFromFlags(flags: LogoutFlags): LogoutTarget[] {
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
