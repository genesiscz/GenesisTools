import { describe, expect, test } from "bun:test";
import type { TimelyConfig } from "@app/timely/types";
import { describeTokenLifetime } from "./token-status";

const NOW_MS = Date.UTC(2026, 6, 28, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function config(overrides: Partial<TimelyConfig>): TimelyConfig {
    return {
        tokens: {
            access_token: "tok",
            token_type: "bearer",
            refresh_token: "ref",
            created_at: NOW_SECONDS,
        },
        ...overrides,
    };
}

describe("describeTokenLifetime", () => {
    test("reports nothing when there is no token", () => {
        expect(describeTokenLifetime(undefined, NOW_MS)).toEqual({ kind: "absent" });
        expect(describeTokenLifetime({}, NOW_MS)).toEqual({ kind: "absent" });
    });

    test("uses expires_in when Timely does send one", () => {
        const lifetime = describeTokenLifetime(
            config({
                tokens: {
                    access_token: "tok",
                    token_type: "bearer",
                    refresh_token: "ref",
                    created_at: NOW_SECONDS - 100,
                    expires_in: 7200,
                },
            }),
            NOW_MS
        );

        expect(lifetime).toEqual({
            kind: "known",
            expiresAt: new Date((NOW_SECONDS - 100 + 7200) * 1000),
            expired: false,
        });
    });

    test("a login three minutes ago reads as freshly authenticated", () => {
        expect(describeTokenLifetime(config({ authenticatedAt: NOW_SECONDS - 180 }), NOW_MS)).toEqual({
            kind: "fresh-login",
            age: "3m",
        });
    });

    test("a login seconds ago still reads as fresh", () => {
        expect(describeTokenLifetime(config({ authenticatedAt: NOW_SECONDS - 2 }), NOW_MS)).toEqual({
            kind: "fresh-login",
            age: "< 1m",
        });
    });

    test("an aged login keeps the old unknown-lifetime answer", () => {
        const threeHours = 3 * 60 * 60;
        expect(describeTokenLifetime(config({ authenticatedAt: NOW_SECONDS - threeHours }), NOW_MS)).toEqual({
            kind: "unknown",
        });
    });

    test("a config written before authenticatedAt existed keeps the old answer", () => {
        expect(describeTokenLifetime(config({}), NOW_MS)).toEqual({ kind: "unknown" });
    });

    test("refreshes do not fake freshness: created_at alone never counts as a login", () => {
        const stale = config({ authenticatedAt: NOW_SECONDS - 10 * 24 * 60 * 60 });
        stale.tokens = { ...stale.tokens!, created_at: NOW_SECONDS };

        expect(describeTokenLifetime(stale, NOW_MS)).toEqual({ kind: "unknown" });
    });
});
