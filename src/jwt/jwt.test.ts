import { describe, expect, it } from "bun:test";
import { resolveTokenInput } from "@app/jwt/lib/token-input";
import { SafeJSON } from "@genesiscz/utils/json";
import { decodeJwt, describeClaimTime, extractJwt, humanizeDelta, normalizeTokenText } from "@genesiscz/utils/jwt";

// Public jwt.io sample token (HS256). Decoding needs no secret.
const SAMPLE =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
    ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("decodeJwt", () => {
    it("decodes header and payload of a valid token", () => {
        const result = decodeJwt(SAMPLE);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error("expected ok");
        }

        expect(result.header).toEqual({ alg: "HS256", typ: "JWT" });
        expect(result.payload).toEqual({ sub: "1234567890", name: "John Doe", iat: 1516239022 });
        expect(result.signature).toBe("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    });

    it("rejects a token without exactly three segments", () => {
        const result = decodeJwt("aaa.bbb");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error).toContain("3 dot-separated segments");
        expect(result.error).toContain("got 2");
    });

    it("rejects an empty segment", () => {
        const result = decodeJwt("aaa..ccc");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error).toContain("3 dot-separated segments");
    });

    it("rejects a segment that is not valid JSON", () => {
        // "###" is not valid base64url → decodes to garbage that is not JSON.
        const result = decodeJwt("###.###.sig");
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error("expected error");
        }

        expect(result.error.toLowerCase()).toContain("header");
    });

    it("decodes a header or a payload that carries a string property named error", () => {
        const encode = (value: object) =>
            Buffer.from(SafeJSON.stringify(value, { strict: true })).toString("base64url");
        const result = decodeJwt(
            `${encode({ alg: "HS256", error: "custom metadata" })}.${encode({ sub: "1", error: "upstream" })}.sig`
        );

        expect(result).toEqual({
            ok: true,
            header: { alg: "HS256", error: "custom metadata" },
            payload: { sub: "1", error: "upstream" },
            signature: "sig",
        });
    });
});

const SIGNATURE = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

function tokenWithHeader(header: string): string {
    const [, payload] = SAMPLE.split(".");
    return `${Buffer.from(header).toString("base64url")}.${payload}.${SIGNATURE}`;
}

const PRETTY_PRINTED_HEADER = '{\n  "alg": "HS256",\n  "typ": "JWT"\n}';

describe("normalizeTokenText", () => {
    it("trims whitespace and line breaks", () => {
        expect(normalizeTokenText(`  \n${SAMPLE}\r\n `)).toBe(SAMPLE);
    });

    it("strips a leading Bearer in any letter case", () => {
        expect(normalizeTokenText(`Bearer ${SAMPLE}`)).toBe(SAMPLE);
        expect(normalizeTokenText(`bearer   ${SAMPLE}`)).toBe(SAMPLE);
        expect(normalizeTokenText(`BEARER\t${SAMPLE}`)).toBe(SAMPLE);
    });

    it("strips double, single and backtick quotes", () => {
        expect(normalizeTokenText(`"${SAMPLE}"`)).toBe(SAMPLE);
        expect(normalizeTokenText(`'${SAMPLE}'`)).toBe(SAMPLE);
        expect(normalizeTokenText(`\`${SAMPLE}\``)).toBe(SAMPLE);
    });

    it("strips quotes around a Bearer value and a Bearer inside quotes", () => {
        expect(normalizeTokenText(`"Bearer ${SAMPLE}"`)).toBe(SAMPLE);
        expect(normalizeTokenText(`Bearer "${SAMPLE}"`)).toBe(SAMPLE);
        expect(normalizeTokenText(` ' "${SAMPLE}" ' `)).toBe(SAMPLE);
    });

    it("leaves a lone quote and an inner quote alone", () => {
        expect(normalizeTokenText(`"${SAMPLE}`)).toBe(`"${SAMPLE}`);
        expect(normalizeTokenText(`a"b"c`)).toBe(`a"b"c`);
    });

    it("does not treat a token that merely starts with the letters of Bearer as prefixed", () => {
        expect(normalizeTokenText("bearerxyz.a.b")).toBe("bearerxyz.a.b");
    });
});

describe("extractJwt", () => {
    it("returns a bare token unchanged", () => {
        expect(extractJwt(SAMPLE)).toBe(SAMPLE);
    });

    it("cleans a token copied from an Authorization header or a shell", () => {
        expect(extractJwt(`Bearer ${SAMPLE}\n`)).toBe(SAMPLE);
        expect(extractJwt(`"${SAMPLE}"`)).toBe(SAMPLE);
        expect(extractJwt(`  'Bearer ${SAMPLE}'  `)).toBe(SAMPLE);
    });

    it("joins a token that a chat or an email wrapped over several lines", () => {
        const wrapped = `${SAMPLE.slice(0, 40)}\n${SAMPLE.slice(40, 120)}\r\n  ${SAMPLE.slice(120)}`;
        expect(extractJwt(wrapped)).toBe(SAMPLE);
    });

    it("finds the first token inside surrounding text", () => {
        expect(extractJwt(`{"access_token":"${SAMPLE}","expires_in":3600}`)).toBe(SAMPLE);
        expect(extractJwt(`curl -H 'Authorization: Bearer ${SAMPLE}' https://example.com`)).toBe(SAMPLE);
        expect(extractJwt(`first ${SAMPLE}, second ${SAMPLE}x.y.z`)).toBe(SAMPLE);
    });

    it("does not carry trailing punctuation into the token", () => {
        expect(extractJwt(`token: ${SAMPLE}.`)).toBe(SAMPLE);
        expect(extractJwt(`(${SAMPLE})`)).toBe(SAMPLE);
    });

    it("returns null for text with no three-part token", () => {
        expect(extractJwt("")).toBeNull();
        expect(extractJwt("   \n")).toBeNull();
        expect(extractJwt("just some words")).toBeNull();
        expect(extractJwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0")).toBeNull();
        expect(extractJwt("alice@example.com")).toBeNull();
        expect(extractJwt("version 1.2.3")).toBeNull();
    });

    it("does not start a token in the middle of a word", () => {
        expect(extractJwt(`xx${SAMPLE}`)).toBeNull();
    });

    it("accepts a header whose encoding does not start with ey", () => {
        for (const header of [PRETTY_PRINTED_HEADER, '{\t"alg":"HS256"}', ' {"alg":"HS256"}']) {
            const token = tokenWithHeader(header);

            expect(token.startsWith("ey")).toBe(false);
            expect(decodeJwt(token).ok).toBe(true);
            expect(extractJwt(token)).toBe(token);
            expect(extractJwt(`Bearer ${token}\n`)).toBe(token);
            expect(extractJwt(`{"access_token":"${token}","expires_in":3600}`)).toBe(token);
        }
    });

    it("accepts a header with a custom parameter named error", () => {
        for (const header of ['{"alg":"HS256","error":"custom metadata"}', '{"error":"x"}']) {
            const token = tokenWithHeader(header);

            expect(extractJwt(token)).toBe(token);
            expect(extractJwt(`{"access_token":"${token}","expires_in":3600}`)).toBe(token);
            expect(decodeJwt(token).ok).toBe(true);
        }
    });

    it("finds a token that follows dotted words", () => {
        expect(extractJwt(`a.b.${SAMPLE}`)).toBe(SAMPLE);
    });

    it("does not read dotted text as a token, even when its first word encodes to a brace", () => {
        for (const text of ["www.example.com", "example.com.au", "exports.default.value", "see this.props.value."]) {
            expect(extractJwt(text)).toBeNull();
        }
    });
});

describe("resolveTokenInput", () => {
    function neverCalled(what: string): () => Promise<string> {
        return async () => {
            throw new Error(`${what} must not be read here`);
        };
    }

    it("reads the clipboard when asked, and never stdin", async () => {
        const result = await resolveTokenInput({
            clipboard: true,
            interactive: true,
            readClipboard: async () => `Bearer ${SAMPLE}\n`,
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: true, token: SAMPLE, source: "clipboard" });
    });

    it("reads a token with a pretty-printed header from the clipboard, as it does from an argument", async () => {
        const token = tokenWithHeader(PRETTY_PRINTED_HEADER);
        const fromClipboard = await resolveTokenInput({
            clipboard: true,
            interactive: true,
            readClipboard: async () => token,
            readStdin: neverCalled("stdin"),
        });
        const fromArgument = await resolveTokenInput({
            argToken: token,
            interactive: true,
            readClipboard: neverCalled("clipboard"),
            readStdin: neverCalled("stdin"),
        });

        expect(fromClipboard).toEqual({ ok: true, token, source: "clipboard" });
        expect(fromArgument).toEqual({ ok: true, token, source: "argument" });
    });

    it("reads the clipboard when asked even if stdin is piped", async () => {
        const result = await resolveTokenInput({
            clipboard: true,
            interactive: false,
            readClipboard: async () => SAMPLE,
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: true, token: SAMPLE, source: "clipboard" });
    });

    it("fails without echoing a clipboard that holds no token", async () => {
        const result = await resolveTokenInput({
            clipboard: true,
            interactive: true,
            readClipboard: async () => "hunter2 correct horse",
            readStdin: neverCalled("stdin"),
        });
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.failure).toBe("clipboard");
        expect(SafeJSON.stringify(result)).not.toContain("hunter2");
    });

    it("fails clearly when the clipboard cannot be read", async () => {
        const result = await resolveTokenInput({
            clipboard: true,
            interactive: true,
            readClipboard: async () => {
                throw new Error("no clipboard tool");
            },
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({
            ok: false,
            failure: "clipboard",
            error: "could not read the clipboard.",
            clipboardHasJwt: false,
        });
    });

    it("refuses a token argument together with --clipboard, and keeps the signature out of the error", async () => {
        const result = await resolveTokenInput({
            argToken: SAMPLE,
            clipboard: true,
            interactive: true,
            readClipboard: neverCalled("clipboard"),
            readStdin: neverCalled("stdin"),
        });
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.failure).toBe("both");
        expect(SafeJSON.stringify(result)).not.toContain(SIGNATURE);
    });

    it("uses a token argument, cleaned, without touching the clipboard", async () => {
        const result = await resolveTokenInput({
            argToken: ` "Bearer ${SAMPLE}" `,
            interactive: true,
            readClipboard: neverCalled("clipboard"),
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: true, token: SAMPLE, source: "argument" });
    });

    it("reads piped stdin when there is no argument", async () => {
        const result = await resolveTokenInput({
            interactive: false,
            readClipboard: neverCalled("clipboard"),
            readStdin: async () => `${SAMPLE}\n`,
        });
        expect(result).toEqual({ ok: true, token: SAMPLE, source: "stdin" });
    });

    const wrappedSample = `${SAMPLE.slice(0, 40)}\n${SAMPLE.slice(40, 120)}\r\n  ${SAMPLE.slice(120)}`;
    const jsonResponse = `{"access_token":"${SAMPLE}","expires_in":3600}`;

    it("joins a wrapped token and finds one inside larger text in an argument, as --clipboard does", async () => {
        for (const argToken of [wrappedSample, jsonResponse]) {
            const result = await resolveTokenInput({
                argToken,
                interactive: true,
                readClipboard: neverCalled("clipboard"),
                readStdin: neverCalled("stdin"),
            });
            expect(result).toEqual({ ok: true, token: SAMPLE, source: "argument" });
        }
    });

    it("joins a wrapped token and finds one inside larger text on piped stdin, as --clipboard does", async () => {
        for (const piped of [wrappedSample, jsonResponse]) {
            const result = await resolveTokenInput({
                interactive: false,
                readClipboard: neverCalled("clipboard"),
                readStdin: async () => `${piped}\n`,
            });
            expect(result).toEqual({ ok: true, token: SAMPLE, source: "stdin" });
        }
    });

    it("keeps an explicit value that holds no token as cleaned text, so decoding can say what is wrong", async () => {
        const fromArgument = await resolveTokenInput({
            argToken: " 'aaa.bbb' ",
            interactive: true,
            readClipboard: neverCalled("clipboard"),
            readStdin: neverCalled("stdin"),
        });
        expect(fromArgument).toEqual({ ok: true, token: "aaa.bbb", source: "argument" });

        const fromStdin = await resolveTokenInput({
            interactive: false,
            readClipboard: neverCalled("clipboard"),
            readStdin: async () => "aaa.bbb\n",
        });
        expect(fromStdin).toEqual({ ok: true, token: "aaa.bbb", source: "stdin" });
    });

    it("fails on empty piped stdin without peeking at the clipboard", async () => {
        const result = await resolveTokenInput({
            interactive: false,
            readClipboard: neverCalled("clipboard"),
            readStdin: async () => "  \n",
        });
        expect(result).toEqual({ ok: false, failure: "none", error: "no token provided.", clipboardHasJwt: false });
    });

    it("on a terminal with no argument, reads nothing but reports a JWT on the clipboard", async () => {
        const result = await resolveTokenInput({
            interactive: true,
            readClipboard: async () => `"${SAMPLE}"`,
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: false, failure: "none", error: "no token provided.", clipboardHasJwt: true });
    });

    it("on a terminal with no argument, reports no hint for a clipboard without a JWT", async () => {
        const result = await resolveTokenInput({
            interactive: true,
            readClipboard: async () => "grocery list",
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: false, failure: "none", error: "no token provided.", clipboardHasJwt: false });
    });

    it("on a terminal, an unreadable clipboard only drops the hint", async () => {
        const result = await resolveTokenInput({
            interactive: true,
            readClipboard: async () => {
                throw new Error("no clipboard tool");
            },
            readStdin: neverCalled("stdin"),
        });
        expect(result).toEqual({ ok: false, failure: "none", error: "no token provided.", clipboardHasJwt: false });
    });
});

const NOW_MS = 1_700_000_000_000; // fixed injected "now"

describe("humanizeDelta", () => {
    it("formats the largest non-zero unit, floored", () => {
        expect(humanizeDelta(23 * 60_000)).toBe("23m");
        expect(humanizeDelta(2 * 3_600_000)).toBe("2h");
        expect(humanizeDelta(90_000)).toBe("1m");
        expect(humanizeDelta(45_000)).toBe("45s");
        expect(humanizeDelta(3 * 86_400_000)).toBe("3d");
        expect(humanizeDelta(0)).toBe("0s");
    });
});

describe("describeClaimTime", () => {
    it("describes a future exp as 'expires in <Δ>'", () => {
        const expSeconds = (NOW_MS + 23 * 60_000) / 1000;
        expect(describeClaimTime("exp", expSeconds, NOW_MS)).toBe("expires in 23m");
    });

    it("describes a past exp as 'EXPIRED <Δ> ago'", () => {
        const expSeconds = (NOW_MS - 2 * 3_600_000) / 1000;
        expect(describeClaimTime("exp", expSeconds, NOW_MS)).toBe("EXPIRED 2h ago");
    });

    it("describes a past iat as '<Δ> ago'", () => {
        const iatSeconds = (NOW_MS - 5 * 60_000) / 1000;
        expect(describeClaimTime("iat", iatSeconds, NOW_MS)).toBe("5m ago");
    });

    it("describes a future nbf as 'in <Δ>'", () => {
        const nbfSeconds = (NOW_MS + 10 * 60_000) / 1000;
        expect(describeClaimTime("nbf", nbfSeconds, NOW_MS)).toBe("in 10m");
    });
});
