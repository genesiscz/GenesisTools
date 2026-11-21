import { describe, expect, test } from "bun:test";
import {
    currentToolName,
    redactCredentialArgs,
    redactCredentialFields,
    redactCredentialText,
    vaultPurpose,
    withVaultPurpose,
} from "./vault-purpose";

describe("the vault purpose of overlapping runs", () => {
    /** Runs A and B overlap; `order` says which finishes first. Each reads its purpose after the other started. */
    async function overlap(order: "a-first" | "b-first"): Promise<string[]> {
        const seen: string[] = [];
        let releaseA!: () => void;
        let releaseB!: () => void;
        const aWaits = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const bWaits = new Promise<void>((resolve) => {
            releaseB = resolve;
        });
        const a = withVaultPurpose("read meeting A", async () => {
            await aWaits;
            seen.push(`a: ${vaultPurpose()}`);
            await withVaultPurpose("", async () => {
                seen.push(`a nested: ${vaultPurpose()}`);
            });
        });
        const b = withVaultPurpose("read meeting B", async () => {
            await bWaits;
            seen.push(`b: ${vaultPurpose()}`);
        });

        if (order === "a-first") {
            releaseA();
            await a;
            releaseB();
            await b;
        } else {
            releaseB();
            await b;
            releaseA();
            await a;
        }

        seen.push(`after: ${vaultPurpose()}`);
        return seen.sort();
    }

    test("each run keeps its own purpose whichever finishes first, and none is left behind", async () => {
        const expected = ["a nested: read meeting A", "a: read meeting A", "after: undefined", "b: read meeting B"];
        expect(await overlap("a-first")).toEqual(expected);
        expect(await overlap("b-first")).toEqual(expected);
    });

    test("a nested run with its own purpose shows it, then the outer one again", async () => {
        await withVaultPurpose("outer", async () => {
            await withVaultPurpose("inner", async () => {
                expect(vaultPurpose()).toBe("inner");
            });
            expect(vaultPurpose()).toBe("outer");
        });
    });
});

describe("credential header boundaries", () => {
    const secret = "fixture-cookie-r5";
    const safe = "Accept: application/json";
    test("keeps harmless quoted headers after one or several sensitive headers", () => {
        for (const input of [
            `curl -H "Cookie: session=${secret}" -H "${safe}"`,
            `curl -H "Cookie: session=${secret}" -H "Authorization: Bearer ${secret}" -H "${safe}"`,
            `curl -H "Cookie: session='${secret}'" -H "${safe}"`,
            `curl --header Cookie: session="prefix --header ${secret}" --header ${safe}`,
        ]) {
            const output = redactCredentialText(input);
            expect(output).not.toContain(secret);
            expect(output).toContain(safe);
            if (input.includes("Authorization: Bearer")) {
                expect(output).toContain("Authorization: Bearer [REDACTED]");
            }
        }
    });

    test("redacts equals-form header flags in argv and joined commands", () => {
        for (const flag of ["--header", "-H"]) {
            for (const header of [
                `Authorization: Bearer ${secret}`,
                `Proxy-Authorization: Basic ${secret}`,
                `Cookie: session='${secret}'`,
                `X-Api-Key:${secret}`,
            ]) {
                const argv = ["wget", `${flag}=${header}`, `${flag}=${safe}`];
                const original = [...argv];
                for (const output of [
                    redactCredentialArgs(argv).join(" "),
                    redactCredentialText(argv.join(" ")),
                    redactCredentialText(argv.map((word) => `"${word}"`).join(" ")),
                ]) {
                    expect(output).not.toContain(secret);
                    expect(output).toContain(safe);
                    if (header.startsWith("Authorization")) {
                        expect(output).toContain("Authorization: Bearer [REDACTED]");
                    }
                }
                expect(argv).toEqual(original);
            }
        }
    });

    test("CR, LF and CRLF preserve the following harmless header, including Unicode values", () => {
        for (const newline of ["\r", "\n", "\r\n"]) {
            const output = redactCredentialText(`Cookie: session=🔒${secret}${newline}${safe}`);
            expect(output).toBe(`Cookie: [REDACTED]${newline}${safe}`);
        }
    });

    test("scans long whitespace and quoted runs without quadratic work", () => {
        const started = performance.now();
        for (const value of [`x${" ".repeat(131_072)}!`, '"x"'.repeat(43_691)]) {
            const output = redactCredentialText(`curl --header Cookie: ${value}`);
            expect(output).toBe("curl --header Cookie: [REDACTED]");
        }
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("quoted credential flags consume escaped quotes and malformed remainders", () => {
        const secret = "fixture-secret-suffix-r6";
        for (const flag of ["--token", "--api-key", "--key", "--password", "--secret"]) {
            for (const separator of [" ", "="]) {
                for (const quote of ['"', "'"]) {
                    const value = [quote, "prefix\\", quote, secret, quote].join("");
                    const input = ["tools claude", flag + separator + value, "--format json"].join(" ");
                    const expected = ["tools claude", `${flag}${separator}[REDACTED]`, "--format json"].join(" ");
                    expect(redactCredentialText(input)).toBe(expected);
                    expect(redactCredentialFields({ shown: [{ help: input }] })).toEqual({
                        shown: [{ help: expected }],
                    });
                    const unfinished = ["tools claude", flag + separator + value.slice(0, -1), "--format json\\"].join(
                        " "
                    );
                    expect(redactCredentialText(unfinished)).toBe(
                        ["tools claude", `${flag}${separator}[REDACTED]`].join(" ")
                    );
                }
            }
        }
        const relay = ['tools wakeup daemon register -t "prefix\\"', secret, '" --format json'].join("");
        expect(redactCredentialText(relay)).toBe("tools wakeup daemon register -t [REDACTED] --format json");
        expect(redactCredentialText('tools claude tail -t "safe\\"value"')).toBe('tools claude tail -t "safe\\"value"');
    });

    test("uses the last src segment for a tool under a source checkout parent", () => {
        expect(currentToolName(["bun", "/work/src/GenesisTools/src/claude/index.ts"])).toBe("claude");
    });
});
