import { describe, expect, test } from "bun:test";
import { resolveRequestedUser } from "@app/azure-devops/lib/current-user";
import type { IdentityRef } from "@app/azure-devops/types";

const ROSTER: IdentityRef[] = [
    { displayName: "Nováková Tereza (XX)", uniqueName: "tereza.novakova@example.invalid" },
    { displayName: "Dvořák Pavel (YY)", uniqueName: "pavel.dvorak@example.invalid" },
];

const roster = async (): Promise<IdentityRef[]> => ROSTER;

describe("resolveRequestedUser with an explicit --user", () => {
    test("answers with the roster spelling when the name was typed without diacritics", async () => {
        // The history index holds the name as written, so searching for `Novakova` finds nothing
        // and reads as "nobody ever named this person".
        const resolved = await resolveRequestedUser({ user: "Novakova Tereza", teamMembers: roster });

        expect(resolved).toEqual({ name: "Nováková Tereza (XX)", verified: true });
    });

    test("answers with the roster spelling for a name written the other way round", async () => {
        const resolved = await resolveRequestedUser({ user: "Tereza Nováková", teamMembers: roster });

        expect(resolved).toEqual({ name: "Nováková Tereza (XX)", verified: true });
    });

    test("resolves an email to the display name every history record carries", async () => {
        const resolved = await resolveRequestedUser({
            user: "pavel.dvorak@example.invalid",
            teamMembers: roster,
        });

        expect(resolved).toEqual({ name: "Dvořák Pavel (YY)", verified: true });
    });

    test("passes a name the roster does not know through untouched", async () => {
        const resolved = await resolveRequestedUser({ user: "Nobody Here", teamMembers: roster });

        // Unverified: the local cache still matches it fuzzily, but nothing server-side does.
        expect(resolved).toEqual({ name: "Nobody Here", verified: false });
    });

    test("falls back to the name as written when the roster cannot be reached", async () => {
        // An offline scan of the local cache must keep working.
        const failing = async (): Promise<IdentityRef[]> => {
            throw new Error("getaddrinfo ENOTFOUND");
        };

        const resolved = await resolveRequestedUser({ user: "Nováková Tereza (XX)", teamMembers: failing });

        expect(resolved).toEqual({ name: "Nováková Tereza (XX)", verified: false });
    });

    test("never shells out to the Azure CLI for an explicit name", async () => {
        // The roster is the only lookup; reaching the `az` path would make `--user` need a login.
        let asked = 0;
        const counting = async (): Promise<IdentityRef[]> => {
            asked++;

            return ROSTER;
        };

        await resolveRequestedUser({ user: "Dvořák Pavel (YY)", teamMembers: counting });

        expect(asked).toBe(1);
    });
});

describe("resolveRequestedUser with @me", () => {
    const account = async (): Promise<string> => "tereza.novakova@example.invalid";

    test("resolves the signed-in account to the display name every history record carries", async () => {
        const resolved = await resolveRequestedUser({ user: "@me", teamMembers: roster, accountName: account });

        expect(resolved).toEqual({ name: "Nováková Tereza (XX)", verified: true });
    });

    test("refuses rather than searching for the account name when the roster cannot be reached", async () => {
        // NOT a fallback to the account name. It is an address, and nothing downstream matches one:
        // `userMatches` compares display names and answered false, and `wiqlMentionTerm` would send
        // the whole address to the history index. Both come back empty, which reads as "nobody ever
        // named you" — the confident-empty answer this search exists to end.
        const failing = async (): Promise<IdentityRef[]> => {
            throw new Error("getaddrinfo ENOTFOUND");
        };

        await expect(resolveRequestedUser({ user: "@me", teamMembers: failing, accountName: account })).rejects.toThrow(
            'Pass the display name instead: --user "<Surname Firstname>"'
        );
    });

    test("refuses when the roster answers but does not list the signed-in account", async () => {
        const stranger = async (): Promise<string> => "nobody@example.invalid";

        await expect(resolveRequestedUser({ user: "@me", teamMembers: roster, accountName: stranger })).rejects.toThrow(
            "nobody@example.invalid"
        );
    });

    test("reports the account lookup failing, since that one has no fallback", async () => {
        const broken = async (): Promise<string> => {
            throw new Error("Could not resolve @me — is the Azure CLI installed and logged in? Run `az login`.");
        };

        await expect(resolveRequestedUser({ user: "@me", teamMembers: roster, accountName: broken })).rejects.toThrow(
            "az login"
        );
    });
});
