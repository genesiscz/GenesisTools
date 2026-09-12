import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { out } from "@genesiscz/utils/logger";
import { resolveAccountName } from "./select-account";

/**
 * Which account a flow targets, when the user named one.
 *
 * The lookup was `name === requested || id === requested` over `find`, so an
 * account whose NAME equals another account's id intercepted an explicit id, and
 * two accounts sharing a name silently resolved to whichever came first
 * (PR #359 review t10). `runLogout` hands the resolved id straight to
 * `clearCredentials`, which is irreversible, so first-match is the wrong answer.
 *
 * These cover the `requested` branch only: it never prompts, so no TTY is
 * involved. Every handle is invented.
 */

let errorLines: string[];
let errLines: string[];
let realError: typeof out.error;
let realPrintlnErr: typeof out.printlnErr;

function account(id: string, name: string, provider = "anthropic-sub"): AccountEntry {
    return {
        id,
        name,
        provider,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };
}

function resolve(requested: string | undefined, accounts: AccountEntry[], fuzzy = false) {
    return resolveAccountName({
        requested,
        accounts,
        message: "Which account?",
        tool: "tools ai accounts logout",
        subcommand: ["accounts", "logout"],
        fuzzy,
    });
}

beforeEach(() => {
    errorLines = [];
    errLines = [];
    realError = out.error;
    out.error = (msg?: unknown, ...rest: unknown[]) => {
        errorLines.push([msg, ...rest].map(String).join(" "));
    };
    realPrintlnErr = out.printlnErr;
    out.printlnErr = (raw?: unknown, ...rest: unknown[]) => {
        errLines.push([raw, ...rest].map(String).join(" "));
    };
});

afterEach(() => {
    out.error = realError;
    out.printlnErr = realPrintlnErr;
});

describe("an explicit id wins over a name that looks like one", () => {
    test("the id is resolved even when another account is NAMED that id", async () => {
        const target = account("acc_work", "work");
        // `personal` is literally named after the other account's id.
        const decoy = account("acc_personal", "acc_work");

        const picked = await resolve("acc_work", [decoy, target]);

        expect(picked.status).toBe("ok");
        expect(picked.status === "ok" && picked.account.id).toBe("acc_work");
    });

    test("NEGATIVE CONTROL: a plain id with no decoy still resolves", async () => {
        const picked = await resolve("acc_work", [account("acc_work", "work")]);

        expect(picked.status === "ok" && picked.account.name).toBe("work");
    });
});

describe("an ambiguous name is refused, never guessed", () => {
    test("two accounts sharing a name produce an error naming both ids", async () => {
        const picked = await resolve("work", [
            account("acc_work_openai", "work", "openai"),
            account("acc_work_anthropic", "work"),
        ]);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("ambiguous");
        expect(errLines.join("\n")).toContain("acc_work_openai");
        expect(errLines.join("\n")).toContain("acc_work_anthropic");
    });

    test("naming one of them by its id resolves it", async () => {
        const picked = await resolve("acc_work_anthropic", [
            account("acc_work_openai", "work", "openai"),
            account("acc_work_anthropic", "work"),
        ]);

        expect(picked.status === "ok" && picked.account.provider).toBe("anthropic-sub");
    });

    test("NEGATIVE CONTROL: a unique name still resolves without an id", async () => {
        const picked = await resolve("personal", [account("acc_work", "work"), account("acc_personal", "personal")]);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_personal");
    });
});

describe("nothing matched", () => {
    test("an unknown value is an error that lists the known names", async () => {
        const picked = await resolve("ghost", [account("acc_work", "work")]);

        expect(picked.status).toBe("error");
        expect(errLines.join("\n")).toContain("work");
    });

    test("an empty inventory is an error before anything else", async () => {
        const picked = await resolve("work", []);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("No accounts configured");
    });
});
describe("fuzzy: a unique substring resolves, an ambiguous one is refused off a TTY", () => {
    test("a substring of one name resolves it", async () => {
        const picked = await resolve("shop", [account("acc_cdx", "cdx-shop"), account("acc_work", "work")], true);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_cdx");
    });

    test("a substring shared by two names is an error naming both (non-TTY)", async () => {
        const picked = await resolve("orb", [account("acc_a", "orbit"), account("acc_b", "info.orbit")], true);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("ambiguous");
        expect(errLines.join("\n")).toContain("info.orbit");
    });

    test("the exact pass still wins over a longer name that contains it", async () => {
        const picked = await resolve("work", [account("acc_work2", "work-2"), account("acc_work", "work")], true);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_work");
    });

    test("NEGATIVE CONTROL: without fuzzy a substring is not found", async () => {
        const picked = await resolve("shop", [account("acc_cdx", "cdx-shop")]);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("not found");
    });
});

describe("a case difference is a typo, not a different account", () => {
    test("a differently-cased name resolves without the substring pass", async () => {
        const picked = await resolve("WORK", [account("acc_work", "work"), account("acc_shop", "shop")]);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_work");
    });

    test("a differently-cased id resolves too", async () => {
        const picked = await resolve("ACC_WORK", [account("acc_work", "work")]);

        expect(picked.status === "ok" && picked.account.name).toBe("work");
    });

    test("the cased-exact name beats a longer name that merely contains it", async () => {
        // Without the case-folded pass this fell through to the substring pass, which matched
        // BOTH and then had to ask which one — for a name the user had spelled in full.
        const picked = await resolve("Shop", [account("acc_shop", "shop"), account("acc_arch", "shop-archive")], true);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_shop");
    });

    test("the literal spelling still wins when both cases exist as separate accounts", async () => {
        const picked = await resolve("work", [account("acc_upper", "Work"), account("acc_lower", "work")]);

        expect(picked.status === "ok" && picked.account.id).toBe("acc_lower");
    });

    test("two accounts differing only in case are refused, never guessed", async () => {
        const picked = await resolve("WORK", [account("acc_upper", "Work"), account("acc_lower", "work")]);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("ambiguous");
        expect(errLines.join("\n")).toContain("acc_upper");
    });

    test("NEGATIVE CONTROL: an unknown name is still not found", async () => {
        const picked = await resolve("GHOST", [account("acc_work", "work")]);

        expect(picked.status).toBe("error");
        expect(errorLines.join("\n")).toContain("not found");
    });
});
