import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

/**
 * Operator-only routes (PATCH /config, POST /cache/clear|prune) must not be
 * reachable with a plain `ytu_` user token even though that token satisfies the
 * global service-key gate. A real service key, open mode, and admin/dev tokens
 * pass; a plain user token gets 403 {code:"forbidden"}.
 */
describe("operator-only routes reject plain user tokens", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-operator-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("PATCH /config: user token 403, service key ok, admin token ok", async () => {
        await env.testing.withOverrides({ YOUTUBE_SERVICE_KEY: "svc_op_key" }, async () => {
            const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

            try {
                handle.youtube.db.createUser({ email: "plain@example.com", passwordHash: "h", apiToken: "ytu_plain" });
                handle.youtube.db.createUser({ email: "admin@example.com", passwordHash: "h", apiToken: "ytu_admin" });
                await handle.youtube.config.update({ powerUsers: [{ email: "admin@example.com", type: "admin" }] });

                const base = `http://localhost:${handle.port}/api/v1/config`;

                const asUser = await fetch(base, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer ytu_plain" },
                    body: SafeJSON.stringify({}),
                });
                expect(asUser.status).toBe(403);
                expect(((await asUser.json()) as { code?: string }).code).toBe("forbidden");

                const asService = await fetch(base, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer svc_op_key" },
                    body: SafeJSON.stringify({}),
                });
                expect(asService.status).toBe(200);

                const asAdmin = await fetch(base, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer ytu_admin" },
                    body: SafeJSON.stringify({}),
                });
                expect(asAdmin.status).toBe(200);
            } finally {
                await handle.stop();
            }
        });
    });

    it("POST /cache/clear rejects a plain user token but allows a service key", async () => {
        await env.testing.withOverrides({ YOUTUBE_SERVICE_KEY: "svc_op_key" }, async () => {
            const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

            try {
                handle.youtube.db.createUser({ email: "plain2@example.com", passwordHash: "h", apiToken: "ytu_plain2" });
                const base = `http://localhost:${handle.port}/api/v1/cache/clear`;

                const asUser = await fetch(base, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer ytu_plain2" },
                    body: SafeJSON.stringify({ all: true }),
                });
                expect(asUser.status).toBe(403);

                const asService = await fetch(base, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer svc_op_key" },
                    body: SafeJSON.stringify({ all: true }),
                });
                expect(asService.status).toBe(200);
            } finally {
                await handle.stop();
            }
        });
    });
});
