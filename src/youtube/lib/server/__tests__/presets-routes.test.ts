import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

describe("youtube server presets routes", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-presets-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function registeredToken(port: number, email: string): Promise<string> {
        const res = await fetch(`http://localhost:${port}/api/v1/users/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ email, password: "hunter22" }),
        });
        const body = (await res.json()) as { token: string };
        return body.token;
    }

    it("create -> list -> update -> delete round trip", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const token = await registeredToken(handle.port, "preset-user@example.com");
            const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

            const createRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets`, {
                method: "POST",
                headers: auth,
                body: SafeJSON.stringify({
                    name: "Skeptic mode",
                    kind: "summary",
                    instructions: "Rate every claim's evidence.",
                }),
            });
            const createBody = (await createRes.json()) as { preset: { id: number; name: string } };

            expect(createRes.status).toBe(200);
            expect(createBody.preset.name).toBe("Skeptic mode");

            const listRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const listBody = (await listRes.json()) as { presets: Array<{ id: number }> };

            expect(listRes.status).toBe(200);
            expect(listBody.presets).toHaveLength(1);

            const presetId = createBody.preset.id;
            const updateRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets/${presetId}`, {
                method: "PUT",
                headers: auth,
                body: SafeJSON.stringify({ instructions: "Updated instructions." }),
            });
            const updateBody = (await updateRes.json()) as { preset: { instructions: string } };

            expect(updateRes.status).toBe(200);
            expect(updateBody.preset.instructions).toBe("Updated instructions.");

            const deleteRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets/${presetId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(deleteRes.status).toBe(200);

            const listAfterDelete = await fetch(`http://localhost:${handle.port}/api/v1/users/presets`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const listAfterDeleteBody = (await listAfterDelete.json()) as { presets: unknown[] };
            expect(listAfterDeleteBody.presets).toHaveLength(0);
        } finally {
            await handle.stop();
        }
    });

    it("rejects over-cap creation with 422, not silent truncation", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const token = await registeredToken(handle.port, "cap-user@example.com");
            const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
            const tooLong = "x".repeat(1001);

            const res = await fetch(`http://localhost:${handle.port}/api/v1/users/presets`, {
                method: "POST",
                headers: auth,
                body: SafeJSON.stringify({ name: "Too long", kind: "ask", instructions: tooLong }),
            });

            expect(res.status).toBe(422);
        } finally {
            await handle.stop();
        }
    });

    it("update/delete of another user's preset 404s", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const tokenA = await registeredToken(handle.port, "owner-preset@example.com");
            const tokenB = await registeredToken(handle.port, "attacker-preset@example.com");
            const createRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
                body: SafeJSON.stringify({ name: "A's preset", kind: "summary", instructions: "Text." }),
            });
            const { preset } = (await createRes.json()) as { preset: { id: number } };

            const updateRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets/${preset.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
                body: SafeJSON.stringify({ name: "Hijacked" }),
            });
            expect(updateRes.status).toBe(404);

            const deleteRes = await fetch(`http://localhost:${handle.port}/api/v1/users/presets/${preset.id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${tokenB}` },
            });
            expect(deleteRes.status).toBe(404);
        } finally {
            await handle.stop();
        }
    });

    it("summary generation with an unknown presetId 404s before spending credits", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const token = await registeredToken(handle.port, "gen-user@example.com");
            handle.youtube.db.upsertChannel({ handle: "@chan" });
            handle.youtube.db.upsertVideo({ id: "vidPreset", channelHandle: "@chan", title: "T" });
            handle.youtube.db.saveTranscript({
                videoId: "vidPreset",
                lang: "en",
                source: "captions",
                text: "Some transcript text.",
                segments: [{ text: "Some transcript text.", start: 0, end: 10 }],
                durationSec: 10,
            });
            const before = handle.youtube.db.getUserByToken(token)?.credits;

            const res = await fetch(`http://localhost:${handle.port}/api/v1/videos/vidPreset/summary`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: SafeJSON.stringify({ mode: "short", presetId: 999999 }),
            });

            expect(res.status).toBe(404);
            expect(handle.youtube.db.getUserByToken(token)?.credits).toBe(before);
        } finally {
            await handle.stop();
        }
    });
});
