import { afterEach, describe, expect, it } from "bun:test";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { findFreePort } from "@app/utils/net/free-port";
import { resetBoardsBaseUrl } from "./http";
import { handleAttachAfter, handleHighlight, handleReply, handleSetStatus } from "./work-tools";

interface RecordedRequest {
    method: string;
    path: string;
    body: unknown;
}

async function stubServer(respond: (req: RecordedRequest) => { status: number; body: unknown }) {
    const requests: RecordedRequest[] = [];
    const port = await findFreePort();
    const server = Bun.serve({
        port,
        fetch: async (req) => {
            const url = new URL(req.url);
            const bodyText = await req.text();
            const body = bodyText ? SafeJSON.parse(bodyText, { strict: true }) : undefined;
            const recorded = { method: req.method, path: `${url.pathname}${url.search}`, body };
            requests.push(recorded);
            const { status, body: resBody } = respond(recorded);
            return Response.json(resBody, { status });
        },
    });
    env.testing.set("BOARDS_BASE_URL", `http://127.0.0.1:${port}`);
    return { requests, stop: () => server.stop() };
}

afterEach(() => {
    env.testing.unset("BOARDS_BASE_URL");
    resetBoardsBaseUrl();
});

describe("handleSetStatus", () => {
    it("PATCHes the annotation with status + actor", async () => {
        const { requests, stop } = await stubServer((req) => ({
            status: 200,
            body: { id: 1, status: (req.body as { status: string }).status },
        }));
        try {
            const out = await handleSetStatus({ id: 1, status: "working" });
            expect(requests).toHaveLength(1);
            expect(requests[0].method).toBe("PATCH");
            expect(requests[0].path).toBe("/api/boards/annotations/1");
            expect(requests[0].body).toEqual({ status: "working", actor: "claude" });
            expect(SafeJSON.parse(out, { strict: true })).toEqual({ id: 1, status: "working" });
        } finally {
            stop();
        }
    });

    it("surfaces a 409 cancelled body in the thrown error text", async () => {
        const { stop } = await stubServer(() => ({ status: 409, body: { code: "cancelled" } }));
        try {
            await expect(handleSetStatus({ id: 1, status: "working" })).rejects.toThrow(/cancelled/);
        } finally {
            stop();
        }
    });
});

describe("handleReply", () => {
    it("POSTs a message authored as claude", async () => {
        const { requests, stop } = await stubServer((req) => ({
            status: 201,
            body: { id: 2, ...(req.body as object) },
        }));
        try {
            await handleReply({ id: 5, text: "fixed in v2" });
            expect(requests).toHaveLength(1);
            expect(requests[0].method).toBe("POST");
            expect(requests[0].path).toBe("/api/boards/annotations/5/messages");
            expect(requests[0].body).toEqual({ body: "fixed in v2", author: "claude" });
        } finally {
            stop();
        }
    });
});

describe("handleAttachAfter", () => {
    it("POSTs the attempt with project/branch/selector/file/agent/commit", async () => {
        const { requests, stop } = await stubServer(() => ({
            status: 201,
            body: { attempt: { id: 1 }, card: { id: 2 } },
        }));
        try {
            await handleAttachAfter({
                id: 5,
                project: "vitrinka",
                branch: "main",
                selector: "latest",
                file: "shot.png",
                commit: "abc123",
            });
            expect(requests).toHaveLength(1);
            expect(requests[0].path).toBe("/api/boards/annotations/5/attempts");
            expect(requests[0].body).toEqual({
                project: "vitrinka",
                branch: "main",
                selector: "latest",
                file: "shot.png",
                agent: "claude",
                commit: "abc123",
            });
        } finally {
            stop();
        }
    });
});

describe("handleHighlight", () => {
    it("fetches the annotation then posts a 5-point closed rect with default amber", async () => {
        const { requests, stop } = await stubServer((req) => {
            if (req.method === "GET") {
                return {
                    status: 200,
                    body: { id: 7, boardSlug: "demo", cardId: 3, region: { x: 10, y: 20, w: 100, h: 50 } },
                };
            }
            return { status: 201, body: { strokes: [{ id: 1 }] } };
        });
        try {
            await handleHighlight({ id: 7 });
            expect(requests).toHaveLength(2);
            expect(requests[0].method).toBe("GET");
            expect(requests[0].path).toBe("/api/boards/annotations/7");
            expect(requests[1].method).toBe("POST");
            expect(requests[1].path).toBe("/api/boards/demo/strokes");
            const body = requests[1].body as { strokes: Array<{ cardId: number; path: number[][]; color: string }> };
            expect(body.strokes).toHaveLength(1);
            expect(body.strokes[0].cardId).toBe(3);
            expect(body.strokes[0].color).toBe("#ffb020");
            expect(body.strokes[0].path).toEqual([
                [10, 20, 0.5],
                [110, 20, 0.5],
                [110, 70, 0.5],
                [10, 70, 0.5],
                [10, 20, 0.5],
            ]);
        } finally {
            stop();
        }
    });
});
