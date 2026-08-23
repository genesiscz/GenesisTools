import { describe, expect, test } from "bun:test";
import { LONG_TOKEN_MIN_LENGTH } from "@genesiscz/utils/claude/token-verify";
import type { AIAccountTokens } from "@genesiscz/utils/config/ai.types";
import { formatWarmupViaHint, sendWarmupMessage } from "./service";

const LONG = "x".repeat(LONG_TOKEN_MIN_LENGTH);
const INVALID_GRANT = "Token expired (invalid_grant). Run: tools claude login bfbc";

function tokens(partial: AIAccountTokens): AIAccountTokens {
    return partial;
}

describe("formatWarmupViaHint", () => {
    test("oauth and missing via print nothing", () => {
        expect(formatWarmupViaHint()).toBe("");
        expect(formatWarmupViaHint("oauth")).toBe("");
    });

    test("login-long is named in the user-facing suffix", () => {
        expect(formatWarmupViaHint("login-long")).toBe(" used login-long token");
    });
});

describe("sendWarmupMessage", () => {
    test("OAuth success does not touch the login-long token", async () => {
        const longLivedCalls: string[] = [];
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "at", refreshToken: "rt", longLivedToken: LONG }),
            sendOAuth: async () => {},
            sendLongLived: async (token) => {
                longLivedCalls.push(token);
                return "ok";
            },
        });

        expect(result).toEqual({ success: true, via: "oauth" });
        expect(longLivedCalls).toEqual([]);
    });

    test("invalid_grant falls back to login-long and reports it", async () => {
        const oauthCalls: string[] = [];
        const longLivedCalls: string[] = [];
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "dead", refreshToken: "dead", longLivedToken: LONG }),
            sendOAuth: async (name) => {
                oauthCalls.push(name);
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async (token) => {
                longLivedCalls.push(token);
                return "ok";
            },
        });

        expect(oauthCalls).toEqual(["bfbc"]);
        expect(longLivedCalls).toEqual([LONG]);
        expect(result).toEqual({ success: true, via: "login-long" });
    });

    test("a 429 on login-long still counts as warmup success", async () => {
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "dead", refreshToken: "dead", longLivedToken: LONG }),
            sendOAuth: async () => {
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async () => "limited",
        });

        expect(result).toEqual({ success: true, via: "login-long" });
    });

    test("invalid_grant with no login-long token fails", async () => {
        let longLivedCalled = false;
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "dead", refreshToken: "dead" }),
            sendOAuth: async () => {
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async () => {
                longLivedCalled = true;
                return "ok";
            },
        });

        expect(longLivedCalled).toBe(false);
        expect(result).toEqual({ success: false });
    });

    test("a truncated login-long token is treated as absent", async () => {
        let longLivedCalled = false;
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () =>
                tokens({ accessToken: "dead", refreshToken: "dead", longLivedToken: "sk-ant-oat01-short" }),
            sendOAuth: async () => {
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async () => {
                longLivedCalled = true;
                return "ok";
            },
        });

        expect(longLivedCalled).toBe(false);
        expect(result).toEqual({ success: false });
    });

    test("an expired minted login-long token is not used", async () => {
        let longLivedCalled = false;
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () =>
                tokens({
                    accessToken: "dead",
                    refreshToken: "dead",
                    longLivedToken: LONG,
                    longLivedTokenExpiresAt: Date.now() - 1_000,
                }),
            sendOAuth: async () => {
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async () => {
                longLivedCalled = true;
                return "ok";
            },
        });

        expect(longLivedCalled).toBe(false);
        expect(result).toEqual({ success: false });
    });

    test("a non-auth OAuth error does not fall back to login-long", async () => {
        let longLivedCalled = false;
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "at", refreshToken: "rt", longLivedToken: LONG }),
            sendOAuth: async () => {
                throw new Error("No haiku model available");
            },
            sendLongLived: async () => {
                longLivedCalled = true;
                return "ok";
            },
        });

        expect(longLivedCalled).toBe(false);
        expect(result).toEqual({ success: false });
    });

    test("login-long invalid after invalid_grant is a failure", async () => {
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "dead", refreshToken: "dead", longLivedToken: LONG }),
            sendOAuth: async () => {
                throw new Error(INVALID_GRANT);
            },
            sendLongLived: async () => "invalid",
        });

        expect(result).toEqual({ success: false });
    });

    test("no OAuth pair uses login-long directly", async () => {
        const oauthCalls: string[] = [];
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ longLivedToken: LONG }),
            sendOAuth: async (name) => {
                oauthCalls.push(name);
            },
            sendLongLived: async () => "ok",
        });

        expect(oauthCalls).toEqual([]);
        expect(result).toEqual({ success: true, via: "login-long" });
    });

    test("credential-less accounts fail without sending", async () => {
        let oauthCalled = false;
        let longLivedCalled = false;
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({}),
            sendOAuth: async () => {
                oauthCalled = true;
            },
            sendLongLived: async () => {
                longLivedCalled = true;
                return "ok";
            },
        });

        expect(oauthCalled).toBe(false);
        expect(longLivedCalled).toBe(false);
        expect(result).toEqual({ success: false });
    });

    test("an unreadable token store fails the warmup without throwing", async () => {
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => {
                throw new Error("ENOENT config");
            },
            sendOAuth: async () => {
                throw new Error("should not send");
            },
            sendLongLived: async () => "ok",
        });

        expect(result).toEqual({ success: false });
    });

    test("a 401 from OAuth also falls back to login-long", async () => {
        const result = await sendWarmupMessage("bfbc", {
            loadTokens: async () => tokens({ accessToken: "stale", refreshToken: "stale", longLivedToken: LONG }),
            sendOAuth: async () => {
                throw new Error("Unauthorized: 401");
            },
            sendLongLived: async () => "ok",
        });

        expect(result).toEqual({ success: true, via: "login-long" });
    });
});
