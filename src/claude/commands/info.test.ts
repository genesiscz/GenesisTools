import { describe, expect, test } from "bun:test";
import { resolveInfoAccount } from "./info";

const vaultRead = async (): Promise<never> => {
    throw new Error("the vault was opened: the keychain would ask the user for gt-claude");
};

describe("tools claude info: which account", () => {
    test("a named account reads names only and never opens the vault", async () => {
        const account = await resolveInfoAccount({
            name: "work",
            readAccounts: async () => [{ name: "personal" }, { name: "work", label: "max 20x" }],
            loadSecrets: vaultRead,
            readToken: async () => "tok-work",
        });

        expect(account).toEqual({ name: "work", label: "max 20x" });
    });

    test("a token on stdin is matched against the stored tokens", async () => {
        const account = await resolveInfoAccount({
            name: undefined,
            readAccounts: vaultRead,
            loadSecrets: async () => ({
                getAccountsByProvider: () => [
                    { name: "personal", provider: "anthropic-sub", tokens: { longLivedToken: "tok-personal" } },
                    { name: "work", provider: "anthropic-sub", tokens: { longLivedToken: "tok-work" } },
                ],
            }),
            readToken: async () => "tok-work",
        });

        expect(account?.name).toBe("work");
    });

    test("no name and no token reads nothing", async () => {
        const account = await resolveInfoAccount({
            name: undefined,
            readAccounts: vaultRead,
            loadSecrets: vaultRead,
            readToken: async () => null,
        });

        expect(account).toBeNull();
    });
});
