import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { handleUsersRoute } from "@app/youtube/lib/server/routes/users";
import { Youtube } from "@app/youtube/lib/youtube";

let dir: string;
let db: YoutubeDatabase;
let yt: Youtube;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-user-settings-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    db.createUser({ email: "u@example.com", passwordHash: "h", apiToken: "ytu_u" });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, token: string | null, body?: unknown) {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = { method };
    const headers: Record<string, string> = {};

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = SafeJSON.stringify(body, { strict: true });
    }

    init.headers = headers;
    const req = new Request(url, init);
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/v1/users/settings", () => {
    it("401 for anonymous", async () => {
        const res = await call("GET", "/api/v1/users/settings", null);

        expect(res.status).toBe(401);
        expect(res.json.code).toBe("login_required");
    });

    it("returns defaults for a fresh user", async () => {
        const res = await call("GET", "/api/v1/users/settings", "ytu_u");

        expect(res.status).toBe(200);
        expect(res.json.settings).toEqual({
            theme: "system",
            density: "comfortable",
            accent: undefined,
            taskDefaults: {},
            panel: {},
        });
    });
});

describe("PATCH /api/v1/users/settings", () => {
    it("validates, deep-merges, and persists across calls", async () => {
        const first = await call("PATCH", "/api/v1/users/settings", "ytu_u", {
            theme: "dark",
            taskDefaults: { summary: { tone: "funny", length: "detailed" } },
            panel: { autoOpen: true },
        });

        expect(first.status).toBe(200);
        expect((first.json.settings as Record<string, unknown>).theme).toBe("dark");

        // second patch merges: summary.tone replaced, summary.length preserved; panel gains defaultTab
        const second = await call("PATCH", "/api/v1/users/settings", "ytu_u", {
            taskDefaults: { summary: { tone: "actionable" } },
            panel: { defaultTab: "insights" },
        });
        const settings = second.json.settings as {
            theme: string;
            taskDefaults: { summary: { tone: string; length: string } };
            panel: { autoOpen: boolean; defaultTab: string };
        };

        expect(settings.theme).toBe("dark");
        expect(settings.taskDefaults.summary).toEqual({ tone: "actionable", length: "detailed" });
        expect(settings.panel).toEqual({ autoOpen: true, defaultTab: "insights" });

        // persisted: a fresh GET reflects the merged state
        const reread = await call("GET", "/api/v1/users/settings", "ytu_u");

        expect((reread.json.settings as { theme: string }).theme).toBe("dark");
    });

    it("400 on unknown top-level key or bad enum", async () => {
        expect((await call("PATCH", "/api/v1/users/settings", "ytu_u", { bogus: 1 })).status).toBe(400);
        expect((await call("PATCH", "/api/v1/users/settings", "ytu_u", { theme: "neon" })).status).toBe(400);
        expect(
            (await call("PATCH", "/api/v1/users/settings", "ytu_u", { taskDefaults: { summary: { tone: "angry" } } }))
                .status
        ).toBe(400);
    });
});

describe("GET /api/v1/users/me", () => {
    it("includes resolved settings", async () => {
        await call("PATCH", "/api/v1/users/settings", "ytu_u", { density: "compact" });
        const res = await call("GET", "/api/v1/users/me", "ytu_u");

        expect(res.status).toBe(200);
        expect((res.json.settings as { density: string }).density).toBe("compact");
    });
});
