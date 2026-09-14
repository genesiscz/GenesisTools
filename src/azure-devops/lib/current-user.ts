import { resolveUser } from "@app/azure-devops/history";
import type { IdentityRef } from "@app/azure-devops/types";
import { logger } from "@genesiscz/utils/logger";
import { $ } from "bun";

/** A resolved user name, and whether the team roster confirmed that spelling. */
export interface RequestedUser {
    name: string;
    /**
     * False when the roster could not be reached, or did not recognise the name, so `name` is the
     * string that was typed. The local cache still matches it, because `userMatches` is fuzzy, but
     * anything that queries Azure DevOps does not: the history INDEX holds names as written and
     * `[System.ChangedBy]` is an exact identity. A command that asks the server has to say so
     * rather than print the zero rows that come back.
     */
    verified: boolean;
}

/**
 * The display name to match against, and whether the roster confirmed it.
 *
 * `@me` goes through the Azure CLI for the signed-in account and then through the team roster,
 * because the account is an email and every history record carries a display name. It throws with
 * the fix command when the CLI cannot answer, when the roster cannot be reached, and when the
 * roster does not list that account: an address answers zero everywhere downstream, so there is no
 * honest fallback for it. A name typed by hand has one, itself, and comes back `verified: false`.
 * The caller owns the exit.
 */
export async function resolveRequestedUser({
    user,
    teamMembers,
    accountName = azAccountName,
}: {
    user: string;
    teamMembers: () => Promise<IdentityRef[]>;
    accountName?: () => Promise<string>;
}): Promise<RequestedUser> {
    if (user.toLowerCase() !== "@me") {
        // A name typed by hand rarely matches the roster spelling, and `history mentions` searches
        // the history index for the name AS WRITTEN, so `Novakova` without diacritics matches
        // nothing and reads as "nobody ever named you". The roster answers with the canonical
        // display name. A name it does not recognise is passed through exactly as before, and so is
        // every name if the roster cannot be reached, so an offline scan of the local cache still
        // works.
        let members: IdentityRef[];

        try {
            members = await teamMembers();
        } catch (err) {
            logger.debug(`[current-user] team roster unavailable; using '${user}' as written: ${err}`);

            return { name: user, verified: false };
        }

        const matched = resolveUser(user, members)?.displayName;

        if (!matched) {
            logger.debug(`[current-user] '${user}' matched no team member; using it as written`);

            return { name: user, verified: false };
        }

        logger.debug(`[current-user] resolved '${user}' to '${matched}' from the team roster`);

        return { name: matched, verified: true };
    }

    const azUser = await accountName();

    let members: IdentityRef[];

    // `@me` does NOT degrade to the account name the way a typed name degrades to itself. The
    // account is an address, and nothing downstream matches one: `userMatches` compares display
    // names and answered false, and `wiqlMentionTerm` would send the whole address to the history
    // index. Both come back with zero rows, which reads as "nobody ever named you" — the exact
    // confident-empty answer this search exists to end. Failing out loud is the honest outcome.
    try {
        members = await teamMembers();
    } catch (err) {
        logger.debug(`[current-user] team roster unavailable for @me: ${err}`);

        throw new Error(
            `Could not reach the team roster, so @me stops at the signed-in account '${azUser}'. ` +
                `No history record carries an account name, so searching for it would answer zero. ` +
                `Pass the display name instead: --user "<Surname Firstname>".`
        );
    }

    const matched = resolveUser(azUser, members)?.displayName;

    if (!matched) {
        throw new Error(
            `The team roster does not list the signed-in account '${azUser}'. ` +
                `No history record carries an account name, so searching for it would answer zero. ` +
                `Pass the display name instead: --user "<Surname Firstname>".`
        );
    }

    logger.debug(`[current-user] resolved @me to '${matched}' from az account '${azUser}'`);

    return { name: matched, verified: true };
}

/** The signed-in Azure CLI account. Injected in tests, which must never shell out. */
async function azAccountName(): Promise<string> {
    const result = await $`az account show --query user.name -o tsv`.quiet().nothrow();

    if (result.exitCode !== 0) {
        logger.debug(`[current-user] az account show exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
        throw new Error("Could not resolve @me — is the Azure CLI installed and logged in? Run `az login`.");
    }

    const azUser = result.text().trim();

    if (!azUser) {
        throw new Error("Azure CLI returned an empty user name. Run `az login` first.");
    }

    return azUser;
}
