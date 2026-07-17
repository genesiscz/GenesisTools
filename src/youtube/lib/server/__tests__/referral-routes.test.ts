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

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "yt-referral-routes-"));
    db = new YoutubeDatabase(":memory:");
    yt = new Youtube({ baseDir: dir, db });
    const year = new Date().getUTCFullYear();
    await yt.config.update({
        referrals: {
            enabled: true,
            offers: [{ from: `${year}-01-01T00:00:00Z`, to: `${year + 1}-01-01T00:00:00Z`, reward: 25 }],
        },
    });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function createUser(email: string) {
    const user = db.createUser({ email, passwordHash: "h", apiToken: `ytu_${email}` });
    db.grantCredits(user.id, 100, "register-grant");

    return { ...user, credits: 100, token: `ytu_${email}` };
}

async function call(method: string, path: string, token: string, bodyObj?: unknown) {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(bodyObj !== undefined ? { body: SafeJSON.stringify(bodyObj, { strict: true }) } : {}),
    });
    const res = await handleUsersRoute(req, url, yt);

    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("referral flow", () => {
    it("issues a stable code, rewards both sides once, lists masked referees", async () => {
        const referrer = createUser("ref@example.com");
        const referee = createUser("new.person@example.com");
        const first = await call("GET", "/api/v1/users/referral", referrer.token);
        const code = first.json.code as string;

        expect(first.status).toBe(200);
        expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
        expect((await call("GET", "/api/v1/users/referral", referrer.token)).json.code).toBe(code);

        const redeem = await call("POST", "/api/v1/users/referral/redeem", referee.token, { code });

        expect(redeem.status).toBe(200);
        expect(redeem.json.reward).toBe(25);
        expect(db.getUserCredits(referee.id)).toBe(125);
        expect(db.getUserCredits(referrer.id)).toBe(125);

        const again = await call("POST", "/api/v1/users/referral/redeem", referee.token, { code });

        expect(again.status).toBe(409);

        const view = await call("GET", "/api/v1/users/referral", referrer.token);
        const referees = view.json.referees as Array<{ email: string; reward: number }>;

        expect(view.json.totalEarned).toBe(25);
        expect(referees[0].email).toBe("ne***@example.com");
    });

    it("rejects self-referral and unknown codes; 403 offer_inactive when disabled", async () => {
        const user = createUser("self@example.com");
        const code = (await call("GET", "/api/v1/users/referral", user.token)).json.code as string;

        expect((await call("POST", "/api/v1/users/referral/redeem", user.token, { code })).status).toBe(400);
        expect((await call("POST", "/api/v1/users/referral/redeem", user.token, { code: "NOPE2222" })).status).toBe(400);

        await yt.config.update({ referrals: { enabled: false, offers: [] } });
        const other = createUser("other@example.com");
        const inactive = await call("POST", "/api/v1/users/referral/redeem", other.token, { code });

        expect(inactive.status).toBe(403);
        expect(inactive.json.code).toBe("offer_inactive");
    });
});
