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
    dir = mkdtempSync(join(tmpdir(), "yt-users-lang-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "hash", apiToken: `ytu_${email}` });

    return { ...user, token: `ytu_${email}` };
}

async function patchMe(token: string | undefined, body: Record<string, unknown>) {
    const url = new URL("http://localhost/api/v1/users/me");
    const req = new Request(url, {
        method: "PATCH",
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
        },
        body: SafeJSON.stringify(body, { strict: true }),
    });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("PATCH /api/v1/users/me", () => {
    it("updates outputLang and ttsVoice, leaving unspecified fields untouched", async () => {
        const user = createUser("a@example.com");

        const first = await patchMe(user.token, { outputLang: "cs" });

        expect(first.status).toBe(200);
        expect((first.json.user as { outputLang: string | null }).outputLang).toBe("cs");
        expect((first.json.user as { ttsVoice: string | null }).ttsVoice).toBeNull();

        const second = await patchMe(user.token, { ttsVoice: "alloy" });

        expect((second.json.user as { outputLang: string | null }).outputLang).toBe("cs");
        expect((second.json.user as { ttsVoice: string | null }).ttsVoice).toBe("alloy");
    });

    it("rejects an unknown outputLang code", async () => {
        const user = createUser("b@example.com");

        const res = await patchMe(user.token, { outputLang: "zz" });

        expect(res.status).toBe(400);
    });

    it("requires auth", async () => {
        const res = await patchMe(undefined, { outputLang: "cs" });

        expect(res.status).toBe(401);
    });
});
