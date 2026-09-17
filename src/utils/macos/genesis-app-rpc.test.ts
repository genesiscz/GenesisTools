import { describe, expect, test } from "bun:test";
import { isGenesisAppRpcAvailable, isNotifyPostResult, parseReply } from "@genesiscz/utils/macos/genesis-app-rpc";
import { parseNotificationOptions } from "@genesiscz/utils/macos/notifications";

describe("parseReply", () => {
    test("unwraps a success envelope", () => {
        const outcome = parseReply<{ id: string }>("notify.post", '{"ok":true,"result":{"id":"abc"}}', 0, "");

        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.result.id).toBe("abc");
    });

    test("passes the app's own error code through, so the caller can tell denied from broken", () => {
        const line = '{"ok":false,"error":{"code":"denied","message":"not allowed"}}';
        const outcome = parseReply("notify.post", line, 77, "");

        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.error.code).toBe("denied");
    });

    test("an unknown method comes back as method_unknown rather than a parse failure", () => {
        const line = '{"ok":false,"error":{"code":"method_unknown","message":"unknown method notify.nope"}}';
        const outcome = parseReply("notify.nope", line, 69, "");

        expect(!outcome.ok && outcome.error.code).toBe("method_unknown");
    });

    test("non-JSON is a handshake failure, not an app error", () => {
        // Something other than the app answered: a wrapper printing a banner, a shim, a crash log.
        // Reporting it as an app error would send the caller looking in the wrong place.
        const outcome = parseReply("notify.post", "dyld: Library not loaded", 1, "");

        expect(!outcome.ok && outcome.error.code).toBe("handshake");
    });

    test("valid JSON in the wrong shape is also a handshake failure", () => {
        const outcome = parseReply("notify.post", '{"status":"fine"}', 0, "");

        expect(!outcome.ok && outcome.error.code).toBe("handshake");
    });

    test("a failure envelope missing its error object does not crash the parser", () => {
        const outcome = parseReply("notify.post", '{"ok":false}', 70, "boom");

        expect(!outcome.ok && outcome.error.code).toBe("handshake");
    });

    test("a success envelope without a result is a handshake failure", () => {
        const outcome = parseReply("notify.post", '{"ok":true}', 0, "");

        expect(!outcome.ok && outcome.error.code).toBe("handshake");
    });

    test("notify.post rejects a result whose id is not a non-empty string", () => {
        const truncated = parseReply("notify.post", '{"ok":true,"result":{"id":1}}', 0, "", isNotifyPostResult);
        const empty = parseReply("notify.post", '{"ok":true,"result":{"id":""}}', 0, "", isNotifyPostResult);
        const ok = parseReply("notify.post", '{"ok":true,"result":{"id":"abc"}}', 0, "", isNotifyPostResult);

        expect(!truncated.ok && truncated.error.code).toBe("handshake");
        expect(!empty.ok && empty.error.code).toBe("handshake");
        expect(ok.ok && ok.result.id).toBe("abc");
    });
});

describe("parseNotificationOptions", () => {
    test("rejects a payload without a string message", () => {
        expect(parseNotificationOptions({ id: "x" }).ok).toBe(false);
        expect(parseNotificationOptions("hello").ok).toBe(false);
        expect(parseNotificationOptions({ message: 1 }).ok).toBe(false);
    });

    test("accepts a message and optional fields without a cast", () => {
        const parsed = parseNotificationOptions({
            message: "Ship it?",
            title: "GenesisTools",
            id: "ask-1",
            actions: [{ id: "yes", title: "Yes" }],
        });

        expect(parsed.ok).toBe(true);

        if (!parsed.ok) {
            throw new Error("expected ok");
        }

        expect(parsed.value.message).toBe("Ship it?");
        expect(parsed.value.id).toBe("ask-1");
        expect(parsed.value.actions).toEqual([{ id: "yes", title: "Yes" }]);
    });

    test("rejects an id that would escape the reply directory", () => {
        expect(parseNotificationOptions({ message: "x", id: "../mail" }).ok).toBe(false);
        expect(parseNotificationOptions({ message: "x", id: "a/b" }).ok).toBe(false);
        expect(parseNotificationOptions({ message: "x", id: "" }).ok).toBe(false);
    });
});

describe("isGenesisAppRpcAvailable", () => {
    test("is false under the test sandbox, so the notification chain falls through", () => {
        // Tests run with GENESIS_TOOLS_HOME pointed at a sandbox, where no bundle is installed.
        // This is the same code path as a machine that never built the app, and the same one as a
        // user who switched routing off with the disabled marker.
        expect(isGenesisAppRpcAvailable()).toBe(false);
    });
});
