import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { asCacheKey, claudeSessionIdFromMetadata, resolvePromptCacheKey, uuidFromHash } from "./prompt-cache-key";

const SESSION = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("claudeSessionIdFromMetadata", () => {
    it("reads session_id from Claude Code's JSON user_id, and from the older string form", () => {
        const json = SafeJSON.stringify({ device_id: "dev", account_uuid: "acct", session_id: SESSION });

        expect(claudeSessionIdFromMetadata({ user_id: json })).toBe(SESSION);
        expect(
            claudeSessionIdFromMetadata({
                user_id: `user_abc_account_${"1".repeat(8)}-1111-1111-1111-111111111111_session_${SESSION}`,
            })
        ).toBe(SESSION);
        expect(claudeSessionIdFromMetadata({ user_id: "plain-user" })).toBeUndefined();
        expect(claudeSessionIdFromMetadata(undefined)).toBeUndefined();
    });
});

describe("resolvePromptCacheKey", () => {
    const content = { model: "gpt-x", system: "You are terse.", first: { role: "user", content: "hi" } };

    it("forwards a key the client chose, unchanged, over every policy", () => {
        expect(resolvePromptCacheKey({ clientKey: "thread-7", claudeSessionId: SESSION, content })).toEqual({
            key: "thread-7",
            source: "client",
        });
    });

    it("uses Claude Code's session id by default, and falls back to the record, then the content", () => {
        expect(resolvePromptCacheKey({ claudeSessionId: SESSION, recordId: "rec", content })).toEqual({
            key: SESSION,
            source: "claude-session",
        });
        expect(resolvePromptCacheKey({ recordId: SESSION, content })).toEqual({ key: SESSION, source: "record" });
        expect(resolvePromptCacheKey({ content })?.source).toBe("content");
        expect(resolvePromptCacheKey({})).toBeUndefined();
    });

    it("content policy: same conversation, same key; a changed system prompt or model, a new key", () => {
        const key = resolvePromptCacheKey({ policy: "content", claudeSessionId: SESSION, content })?.key;

        expect(key).toMatch(UUID_SHAPE);
        expect(resolvePromptCacheKey({ policy: "content", content })?.key).toBe(key);
        expect(
            resolvePromptCacheKey({ policy: "content", content: { ...content, system: "You are verbose." } })?.key
        ).not.toBe(key);
        expect(resolvePromptCacheKey({ policy: "content", content: { ...content, model: "gpt-y" } })?.key).not.toBe(
            key
        );
    });

    it("sends a UUID: an id that is not one is mapped to a stable UUID-shaped hash", () => {
        expect(asCacheKey(SESSION.toUpperCase())).toBe(SESSION);
        expect(asCacheKey("not-a-uuid")).toMatch(UUID_SHAPE);
        expect(asCacheKey("not-a-uuid")).toBe(uuidFromHash(["not-a-uuid"]));
    });
});
