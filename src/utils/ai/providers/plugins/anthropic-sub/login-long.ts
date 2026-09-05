import * as p from "@clack/prompts";
import { orgMismatch, probeTokenOrg } from "@genesiscz/utils/claude/account-fingerprint";
import { INFERENCE_SCOPE, ONE_YEAR_SECONDS } from "@genesiscz/utils/claude/auth";
import { LONG_TOKEN_MIN_LENGTH, verifyLongLivedToken } from "@genesiscz/utils/claude/token-verify";
import { isInteractive } from "@genesiscz/utils/cli";
import { copyToClipboard } from "@genesiscz/utils/clipboard";
import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import type { AccountEntry } from "../../../config/schema";
import type { AccountFlowContext, LoginOutcome } from "../../account-features";
import { generateAuthUrl, presentAuthUrl, promptAndExchangeCode } from "./login";

export const TOKEN_PREFIX = "sk-ant-oat";
export const SETUP_COMMAND = "claude setup-token";

export function maskLongLivedToken(token: string): string {
    if (token.length < 24) {
        return "****";
    }
    return `${token.slice(0, 20)}…${token.slice(-4)}`;
}

/** The fingerprint shape the two pure gates below compare, read off a v4 account. */
export interface StoredFingerprint {
    organizationUuid?: string;
    accountUuid?: string;
    secondary?: { organizationUuid?: string; accountUuid?: string };
}

export function fingerprintOf(account?: AccountEntry): StoredFingerprint | undefined {
    if (!account) {
        return undefined;
    }

    return {
        organizationUuid: account.organizationUuid,
        accountUuid: account.accountUuid,
        secondary: account.credentials.secondary,
    };
}

/**
 * Mint a 1-year token ourselves instead of shelling out to `claude setup-token`.
 * The server only accepts a custom `expires_in` when the grant carries
 * INFERENCE_SCOPE alone, so this flow deliberately requests nothing else —
 * the resulting token can run inference but cannot read usage or profile.
 */
export async function mintLongLivedToken(
    accountName: string,
    openUrl?: (url: string) => Promise<void>
): Promise<{ token: string; expiresAt: number } | null> {
    p.note(
        [
            "This runs the same OAuth flow as `claude setup-token`, in this terminal.",
            `Scope requested: ${pc.cyan(INFERENCE_SCOPE)} only — the one combination the`,
            "server grants a 1-year token for.",
        ].join("\n"),
        `Mint a long-lived token for "${accountName}"`
    );

    const authUrl = await generateAuthUrl(INFERENCE_SCOPE);

    await presentAuthUrl(authUrl, openUrl);

    // The PKCE session survives a failed exchange, so a fumbled paste costs one
    // retry rather than the whole browser round-trip.
    let tokens = await promptAndExchangeCode({ expiresIn: ONE_YEAR_SECONDS });

    while (!tokens) {
        const again = await p.confirm({ message: "Try pasting the code again?", initialValue: true });

        if (p.isCancel(again) || !again) {
            return null;
        }

        tokens = await promptAndExchangeCode({ expiresIn: ONE_YEAR_SECONDS });
    }

    if (!tokens.accessToken.startsWith(TOKEN_PREFIX)) {
        p.log.warn(`Token does not start with "${TOKEN_PREFIX}" — saving anyway, but check it works.`);
    }

    return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
}

/**
 * The org id to compare an incoming token against.
 *
 * Falls back to the SECONDARY grant's org, which is a real stored fingerprint
 * (PR #343 review t3 round 10). `orgMismatch` returns false whenever `storedOrg`
 * is falsy, so an account identified only by `secondary.organizationUuid` got no
 * comparison at all and a token from another org walked through the verified
 * path — the same hole `accountIsIdentified` closed on the unreachable path.
 */
export function storedOrgFor(account?: {
    organizationUuid?: string;
    secondary?: { organizationUuid?: string };
}): string | undefined {
    return account?.organizationUuid || account?.secondary?.organizationUuid;
}

/**
 * Is this entry already pinned to a specific Anthropic account?
 *
 * EVERY persisted fingerprint counts, not just the top-level org (PR #343 review
 * t1 round 9). All of them are optional, so a migrated or partially populated
 * account can be unmistakably identified while `organizationUuid` is empty —
 * and reading only that field let an unverified token attach to it.
 */
export function accountIsIdentified(account?: {
    organizationUuid?: string;
    accountUuid?: string;
    secondary?: { organizationUuid?: string; accountUuid?: string };
}): boolean {
    return Boolean(
        account?.organizationUuid ||
            account?.accountUuid ||
            account?.secondary?.organizationUuid ||
            account?.secondary?.accountUuid
    );
}

/**
 * What to do when the identity probe could not reach the API.
 *
 * Pure, exported and tested, because this is the security decision and the rest
 * of `confirmTokenIdentity` is prompt wiring. It used to be "save", always —
 * so a timeout, a 429 or any unexpected response reopened the cross-account
 * attribution bug the probe exists to close (PR #343 review t1 round 8).
 *
 *  - unidentified  -> nothing to contradict, an unverified first login is fine
 *  - identified, tty -> ask, defaulting to no
 *  - identified, no tty -> refuse; there is nobody to take the risk knowingly
 */
export function unverifiedSaveDecision(opts: { identified: boolean; interactive: boolean }): "save" | "ask" | "refuse" {
    if (!opts.identified) {
        return "save";
    }

    return opts.interactive ? "ask" : "refuse";
}

/**
 * Prove the token belongs to THIS entry before it is written.
 *
 * `verifyLongLivedToken` only proves a token is valid, never whose it is. Pasting
 * account A's setup-token onto entry B therefore saved silently, and every session
 * launched as B billed A from then on — invisible, because nothing ever failed.
 *
 * Returns the org id to persist (so the first login backfills the fingerprint),
 * or `null` when the user aborted.
 */
export async function confirmTokenIdentity(
    accountName: string,
    token: string,
    stored?: StoredFingerprint
): Promise<{ organizationUuid?: string } | null> {
    const spinner = p.spinner();
    spinner.start("Checking which account this token belongs to...");
    const print = await probeTokenOrg(token);
    const storedOrg = storedOrgFor(stored);
    const identified = accountIsIdentified(stored);

    /**
     * One gate for every path that could not establish WHOSE the token is.
     *
     * Fail CLOSED when there is an identity to violate (review t1 round 8): a
     * timeout, a 429 or any unexpected response used to save regardless. When
     * the entry carries no fingerprint there is nothing to contradict, so an
     * unverified first login is still allowed.
     *
     * Originally this covered only `unreachable`, which left `org-dead` able to
     * overwrite an identified account with no comparison at all, because
     * `orgMismatch` treats a missing incoming org as no mismatch (review t1
     * round 12). Every verdict that yields no org id routes here now, so a new
     * verdict cannot quietly reopen the hole a third time.
     */
    const saveWithoutProvenOwner = async (reason: string): Promise<{ organizationUuid?: string } | null> => {
        const decision = unverifiedSaveDecision({ identified, interactive: isInteractive() });

        if (decision === "save") {
            spinner.stop(pc.yellow(`${reason} — saving unverified.`));
            return {};
        }

        spinner.stop(
            pc.red(
                `${reason}, and "${accountName}" already carries an account fingerprint` +
                    `${storedOrg ? ` (org ${storedOrg})` : ""}.`
            )
        );

        // THROW, never `process.exit` here: `out.*` is fire-and-forget, so exiting
        // in the same tick can tear the stderr pipe down with the diagnostic still
        // queued. The entrypoint awaits `out.flush()` before it exits, and a thrown
        // failure is also what makes this branch testable (PR #360 review t12).
        if (decision === "refuse") {
            throw new Error(
                "Refusing to overwrite an identified account with an unverified token. Retry when the API can name the token's organization."
            );
        }

        const overwriteUnverified = await p.confirm({
            message: `Save unverified anyway? If this token belongs to another account, every session launched as "${accountName}" will bill that account.`,
            initialValue: false,
        });

        if (p.isCancel(overwriteUnverified) || !overwriteUnverified) {
            p.cancel("Cancelled — nothing written.");
            return null;
        }

        return {};
    };

    if (print.verdict === "unreachable") {
        return saveWithoutProvenOwner("Could not reach the API to identify the token");
    }

    if (print.verdict === "invalid") {
        spinner.stop(pc.red("Token rejected by the API."));
        throw new Error("Token rejected by the API — nothing saved.");
    }

    // Reached only for `ok` and `org-dead`. `ok` always carries an org now, but
    // `org-dead` need not — and without one there is nothing to compare, so the
    // same gate applies rather than falling through to a no-op orgMismatch.
    if (!print.organizationUuid) {
        return saveWithoutProvenOwner("The API did not name this token's organization");
    }

    if (print.verdict === "org-dead") {
        spinner.stop(pc.yellow("This token's organization no longer permits OAuth (expired subscription)."));
    } else {
        spinner.stop(`Token belongs to org ${pc.dim(print.organizationUuid)}.`);
    }

    if (!orgMismatch({ storedOrg, incomingOrg: print.organizationUuid })) {
        return { organizationUuid: print.organizationUuid };
    }

    out.println(
        pc.yellow(
            `⚠ This token belongs to a DIFFERENT account than "${accountName}".\n` +
                `  "${accountName}" is org ${storedOrg}\n` +
                `  the pasted token is org ${print.organizationUuid}\n` +
                `  Saving it would make every session launched as "${accountName}" bill the other account.`
        )
    );

    const proceed = await p.confirm({ message: "Save anyway?", initialValue: false });

    if (p.isCancel(proceed) || !proceed) {
        p.cancel("Cancelled — nothing written.");
        return null;
    }

    return { organizationUuid: print.organizationUuid };
}

async function promptForPastedToken(accountName: string): Promise<string> {
    const clipboardOk = await copyToClipboard(SETUP_COMMAND, { silent: true })
        .then(() => true)
        .catch(() => false);

    p.note(
        [
            `1. Open a ${pc.bold("new terminal")} tab/window.`,
            `   (${SETUP_COMMAND} is a full-screen TUI — running it in this process suspends the paste prompt.)`,
            `2. Run:  ${pc.cyan(SETUP_COMMAND)}${clipboardOk ? pc.dim("   (copied to clipboard)") : ""}`,
            `3. Complete the OAuth flow (open the URL, click Authorize, paste the code).`,
            `4. Claude prints a token starting with ${pc.cyan(TOKEN_PREFIX)}. Copy it.`,
            `5. Return here and paste the token below.`,
        ].join("\n"),
        `Attach long-lived token to "${accountName}"`
    );

    const token = await p.password({
        message: `Paste the long-lived token (${TOKEN_PREFIX}...):`,
        validate: (val) => {
            const trimmed = val?.trim();

            if (!trimmed) {
                return "Token is required";
            }

            if (!trimmed.startsWith(TOKEN_PREFIX)) {
                return `Token must start with "${TOKEN_PREFIX}"`;
            }

            // A truncated paste authenticates as nobody, and Claude Code
            // silently falls back to the keychain account instead of failing.
            if (trimmed.length < LONG_TOKEN_MIN_LENGTH) {
                return `Token looks truncated (${trimmed.length} chars, expected ~108). Copy the whole line.`;
            }
        },
    });

    if (p.isCancel(token)) {
        throw new Error("Cancelled");
    }

    return (token as string).trim();
}

export type LoginLongContext = AccountFlowContext & { pastedToken?: string; setupToken?: boolean };

/**
 * Obtain a long-lived token and prove whose it is. Writes nothing: the CLI layer
 * persists it through `applyLongLivedToken` inside `AiConfigStore.mutate`, so a
 * rotation of the OAuth pair during the browser wait is not spread-clobbered.
 */
export async function anthropicLoginLong(ctx: LoginLongContext): Promise<LoginOutcome> {
    const accountName = ctx.account?.name ?? ctx.requestedName;

    if (!accountName) {
        throw new Error("login-long needs an existing account to attach the token to.");
    }

    const stored = fingerprintOf(ctx.account);

    if (ctx.pastedToken === undefined && !ctx.interactive) {
        throw new Error("Attaching a long-lived token requires an interactive terminal.");
    }

    let token = ctx.pastedToken;
    let expiresAt: number | undefined;

    if (token === undefined) {
        const method = ctx.setupToken ? "mint" : await askMethod();

        if (method === "mint") {
            const minted = await mintLongLivedToken(accountName, ctx.openUrl);

            if (!minted) {
                throw new Error("Cancelled");
            }

            token = minted.token;
            expiresAt = minted.expiresAt;
        } else {
            token = await promptForPastedToken(accountName);
        }
    }

    if (expiresAt === undefined) {
        const spinner = p.spinner();
        spinner.start("Verifying the token against the API...");
        const verdict = await verifyLongLivedToken(token);

        if (verdict === "invalid") {
            spinner.stop(pc.red("Token rejected by the API (401/403)."));
            throw new Error(
                "Token rejected by the API (401/403) — nothing saved. Re-run `claude setup-token` and copy the whole line."
            );
        }

        if (verdict === "unreachable") {
            spinner.stop(pc.yellow("Could not reach the API to verify — saving unverified."));
        } else if (verdict === "limited") {
            spinner.stop("Token authenticates (rate-limited, which still proves the login).");
        } else {
            spinner.stop("Token verified.");
        }
    }

    // Valid is not the same as MINE. Prove the owner before writing. The browser
    // decided who authorized on the mint path too, so a stale session there mints
    // a token for the wrong person and the same check applies.
    const identity = await confirmTokenIdentity(accountName, token, stored);

    if (!identity) {
        throw new Error("Cancelled");
    }

    return {
        provider: "anthropic-sub",
        credentials: {
            longLivedToken: token,
            // No expiry on the paste path: a pasted token's lifetime is
            // unknowable, and undefined CLEARS any expiry a previously minted
            // token left behind rather than mislabelling the new one.
            ...(expiresAt === undefined ? {} : { longLivedTokenExpiresAt: expiresAt }),
        },
        identity: { organizationUuid: identity.organizationUuid },
        accountFields: identity.organizationUuid ? { organizationUuid: identity.organizationUuid } : {},
    };
}

async function askMethod(): Promise<"mint" | "paste"> {
    const picked = await p.select({
        message: "How should the long-lived token be obtained?",
        options: [
            {
                value: "mint",
                label: "Run the OAuth flow here",
                hint: "authorize in the browser, paste the code — mints a 1-year token",
            },
            {
                value: "paste",
                label: "Paste a token I already have",
                hint: `from ${SETUP_COMMAND} in another terminal`,
            },
        ],
    });

    if (p.isCancel(picked)) {
        throw new Error("Cancelled");
    }

    return picked as "mint" | "paste";
}
