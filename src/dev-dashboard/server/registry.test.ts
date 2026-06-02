import { describe, expect, it } from "bun:test";
import { createDashboardRouter } from "@app/dev-dashboard/server/registry";

const EXPECTED = [
    "GET /api/system/pulse",
    "GET /api/system/pulse/history",
    "GET /api/tmux/sessions",
    "POST /api/tmux/create",
    "POST /api/tmux/rename",
    "GET /api/ttyd/list",
    "POST /api/ttyd/spawn",
    "POST /api/ttyd/kill",
    "POST /api/ttyd/rename",
    "GET /api/cmux/snapshot",
    "GET /api/cmux/layout",
    "POST /api/cmux/create-terminal",
    "POST /api/cmux/create-workspace",
    "POST /api/cmux/send-session",
    "POST /api/cmux/remove-session",
    "POST /api/cmux/attach",
    "POST /api/cmux/rename",
    "GET /api/weather",
    "GET /api/claude/usage",
    "GET /api/claude/usage/history",
    "GET /api/daemon/status",
    "GET /api/daemon/runs",
    "GET /api/daemon/runs/log",
    "GET /api/containers",
    "GET /api/qa/log",
    "POST /api/qa/read",
    "GET /api/qa/audio-library",
    "GET /api/qa/sound",
    "POST /api/qa/config",
    "GET /api/qa/stream",
    "POST /api/qa/save-to-obsidian",
    "GET /api/attention",
    "GET /api/todos",
    "POST /api/todos/request-access",
    "POST /api/todos",
    "POST /api/todos/complete",
    "PATCH /api/todos",
    "DELETE /api/todos",
    "GET /api/obsidian/tree",
    "POST /api/obsidian/mkdir",
    "GET /api/obsidian/note",
    "POST /api/obsidian/publish",
    "POST /api/obsidian/unpublish",
    "GET /share/:slug",
    "POST /api/e2e/pair",
];

describe("createDashboardRouter", () => {
    it("registers every known route", () => {
        const router = createDashboardRouter();
        const missing = EXPECTED.filter((route) => {
            const [method, pattern] = route.split(" ");
            const probe = pattern.replace(":slug", "tok");

            return router.match(method, probe) === null;
        });

        expect(missing).toEqual([]);
    });
});
