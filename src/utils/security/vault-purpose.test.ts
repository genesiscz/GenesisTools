import { describe, expect, test } from "bun:test";
import { currentToolName, redactCredentialArgs, redactCredentialFields, redactCredentialText } from "./vault-purpose";

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
