import { describe, expect, test } from "bun:test";
import { claudeOAuth } from "@genesiscz/utils/claude/auth";
import { codexOAuth } from "../openai/codex-auth";
import { base64UrlEncode, generatePkcePair, sha256Base64Url } from "./pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generatePkcePair", () => {
    test("returns a base64url verifier, its S256 challenge and a state", async () => {
        const pair = await generatePkcePair();

        expect(pair.verifier).toMatch(BASE64URL);
        expect(pair.state).toMatch(BASE64URL);
        expect(pair.challenge).toMatch(BASE64URL);
        expect(pair.challenge).toBe(await sha256Base64Url(pair.verifier));
        // A challenge equal to the verifier would mean "plain", which neither
        // authorization server accepts for these clients.
        expect(pair.challenge).not.toBe(pair.verifier);
    });

    test("two calls never repeat", async () => {
        const [first, second] = await Promise.all([generatePkcePair(), generatePkcePair()]);

        expect(first.verifier).not.toBe(second.verifier);
        expect(first.state).not.toBe(second.state);
    });

    test("the byte length is per client: 32 for Anthropic, 43 for OpenAI", async () => {
        const anthropic = await generatePkcePair();
        const openai = await generatePkcePair({ verifierBytes: 43 });

        expect(anthropic.verifier.length).toBe(base64UrlEncode(new Uint8Array(32)).length);
        expect(openai.verifier.length).toBe(base64UrlEncode(new Uint8Array(43)).length);
    });
});

/**
 * The extraction is only safe if both clients still build a URL the server would
 * accept. Neither call touches the network: `startLogin` only composes a URL.
 */
describe("both clients still build an authorize URL", () => {
    test("claude", async () => {
        const url = new URL(await claudeOAuth.startLogin());

        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toMatch(BASE64URL);
        expect(url.searchParams.get("state")).toMatch(BASE64URL);
    });

    test("codex", async () => {
        const url = new URL(await codexOAuth.startLogin());

        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toMatch(BASE64URL);
        expect(url.searchParams.get("state")).toMatch(BASE64URL);
    });
});
