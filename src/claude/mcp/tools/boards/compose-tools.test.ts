import { afterEach, describe, expect, it } from "bun:test";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { findFreePort } from "@app/utils/net/free-port";
import {
    handleArrange,
    handleAskBoard,
    handleComposeBoard,
    handleCreateBoard,
    handleGetTemplates,
    handleListProjects,
    handleListSections,
    handleScrapeBoard,
    handleUpdateCards,
    handleUpdateSet,
} from "./compose-tools";
import { resetBoardsBaseUrl } from "./http";

interface RecordedRequest {
    method: string;
    path: string;
    body: unknown;
}

async function stubServer(respond: (req: RecordedRequest) => { status: number; body: unknown; text?: string }) {
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
            const { status, body: resBody, text } = respond(recorded);
            if (text !== undefined) {
                return new Response(text, { status, headers: { "content-type": "text/markdown" } });
            }
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

describe("handleAskBoard", () => {
    it("POSTs prompt/options, omitting multiSelect/cardId when unset", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: { id: 1 } }));
        try {
            await handleAskBoard({ board: "b1", prompt: "pick one", options: ["a", "b"] });
            expect(requests[0].method).toBe("POST");
            expect(requests[0].path).toBe("/api/boards/b1/questions");
            expect(requests[0].body).toEqual({ prompt: "pick one", options: ["a", "b"] });
        } finally {
            stop();
        }
    });

    it("includes multiSelect and cardId when given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: { id: 1 } }));
        try {
            await handleAskBoard({ board: "b1", prompt: "pick some", options: ["a"], multiSelect: true, cardId: 7 });
            expect(requests[0].body).toEqual({ prompt: "pick some", options: ["a"], multiSelect: true, cardId: 7 });
        } finally {
            stop();
        }
    });
});

describe("handleCreateBoard", () => {
    it("POSTs slug only when title/project are unset, and returns the board page url", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: { id: 1, slug: "b1" } }));
        try {
            const out = SafeJSON.parse(await handleCreateBoard({ slug: "b1" }), { strict: true }) as { url: string };
            expect(requests[0].method).toBe("POST");
            expect(requests[0].path).toBe("/api/boards");
            expect(requests[0].body).toEqual({ slug: "b1" });
            expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/boards\/b1$/);
        } finally {
            stop();
        }
    });

    it("prefers the server-provided url over the API base", async () => {
        const { stop } = await stubServer(() => ({
            status: 201,
            body: { id: 1, slug: "b1", url: "https://mac.example.dev/boards/b1" },
        }));
        try {
            const out = SafeJSON.parse(await handleCreateBoard({ slug: "b1" }), { strict: true }) as { url: string };
            expect(out.url).toBe("https://mac.example.dev/boards/b1");
        } finally {
            stop();
        }
    });

    it("includes title and project when given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: { id: 1 } }));
        try {
            await handleCreateBoard({ slug: "b1", title: "Board One", project: "proj" });
            expect(requests[0].body).toEqual({ slug: "b1", title: "Board One", project: "proj" });
        } finally {
            stop();
        }
    });
});

describe("handleComposeBoard", () => {
    it("POSTs cards/edges/questions defaulting to empty arrays, omitting unset optional fields", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: { cards: [] } }));
        try {
            await handleComposeBoard({ board: "b1", cards: [{ kind: "text", payload: { md: "hi" } }] });
            expect(requests[0].path).toBe("/api/boards/b1/compose");
            expect(requests[0].body).toEqual({
                cards: [{ kind: "text", payload: { md: "hi" } }],
                edges: [],
                questions: [],
            });
        } finally {
            stop();
        }
    });

    it("appends the board page url to the compose response", async () => {
        const { stop } = await stubServer(() => ({ status: 201, body: { cards: [] } }));
        try {
            const out = SafeJSON.parse(await handleComposeBoard({ board: "b1" }), { strict: true }) as {
                url: string;
            };
            expect(out.url).toMatch(/\/boards\/b1$/);
        } finally {
            stop();
        }
    });

    it("rewrites a 404 into a boards_create_board hint", async () => {
        const { stop } = await stubServer(() => ({
            status: 404,
            body: { error: "board not found: ghost", code: "not_found", index: -1 },
        }));
        try {
            await expect(handleComposeBoard({ board: "ghost" })).rejects.toThrow(/boards_create_board/);
        } finally {
            stop();
        }
    });

    it("passes through layout/section/journey/pass/anchorCardId when given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 201, body: {} }));
        try {
            await handleComposeBoard({
                board: "b1",
                layout: "row",
                section: "Checkout",
                journey: "checkout",
                pass: "next",
            });
            expect(requests[0].body).toEqual({
                layout: "row",
                section: "Checkout",
                journey: "checkout",
                pass: "next",
                cards: [],
                edges: [],
                questions: [],
            });
        } finally {
            stop();
        }
    });
});

describe("handleArrange", () => {
    it("POSTs mode, omitting unset knobs", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { ok: true } }));
        try {
            await handleArrange({ board: "b1", mode: "grid" });
            expect(requests[0].path).toBe("/api/boards/b1/arrange");
            expect(requests[0].body).toEqual({ mode: "grid" });
        } finally {
            stop();
        }
    });

    it("includes scope/ids/gap/padding/cols/sizing/save/sections when given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { ok: true } }));
        try {
            await handleArrange({
                board: "b1",
                mode: "compare",
                scope: "section:Checkout",
                ids: [1, 2],
                gap: "M",
                padding: 24,
                cols: 2,
                sizing: "uniform",
                save: true,
                sections: ["A", "B"],
            });
            expect(requests[0].body).toEqual({
                mode: "compare",
                scope: "section:Checkout",
                ids: [1, 2],
                gap: "M",
                padding: 24,
                cols: 2,
                sizing: "uniform",
                save: true,
                sections: ["A", "B"],
            });
        } finally {
            stop();
        }
    });
});

describe("handleUpdateCards", () => {
    it("POSTs patch/remove defaulting to empty arrays, omitting restore when unset", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { ok: true } }));
        try {
            await handleUpdateCards({ board: "b1", patch: [{ id: 1, x: 10 }] });
            expect(requests[0].path).toBe("/api/boards/b1/update-cards");
            expect(requests[0].body).toEqual({ patch: [{ id: 1, x: 10 }], remove: [] });
        } finally {
            stop();
        }
    });

    it("includes restore when given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { ok: true } }));
        try {
            await handleUpdateCards({ board: "b1", restore: [5] });
            expect(requests[0].body).toEqual({ patch: [], remove: [], restore: [5] });
        } finally {
            stop();
        }
    });
});

describe("handleScrapeBoard", () => {
    it("GETs with no query when section/diff are unset", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { cards: [] } }));
        try {
            await handleScrapeBoard({ board: "b1" });
            expect(requests[0].method).toBe("GET");
            expect(requests[0].path).toBe("/api/boards/b1/scrape");
        } finally {
            stop();
        }
    });

    it("GETs with ?section= when section is given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { cards: [] } }));
        try {
            await handleScrapeBoard({ board: "b1", section: "Checkout" });
            expect(requests[0].path).toBe("/api/boards/b1/scrape?section=Checkout");
        } finally {
            stop();
        }
    });

    it("GETs with ?diff=a,b when exactly two diff names are given", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: {} }));
        try {
            await handleScrapeBoard({ board: "b1", diff: ["A", "B"] });
            expect(requests[0].path).toBe("/api/boards/b1/scrape?diff=A%2CB");
        } finally {
            stop();
        }
    });
});

describe("handleListSections", () => {
    it("GETs the board's sections", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { sections: [] } }));
        try {
            await handleListSections({ board: "b1" });
            expect(requests[0].path).toBe("/api/boards/b1/sections");
        } finally {
            stop();
        }
    });
});

describe("handleListProjects", () => {
    it("GETs /api/boards/projects", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: { projects: [] } }));
        try {
            await handleListProjects();
            expect(requests[0].path).toBe("/api/boards/projects");
        } finally {
            stop();
        }
    });
});

describe("handleUpdateSet", () => {
    it("PATCHes only the given fields", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: {} }));
        try {
            await handleUpdateSet({ project: "p", branch: "main", selector: "latest", name: "checkout-v2" });
            expect(requests[0].method).toBe("PATCH");
            expect(requests[0].path).toBe("/api/boards/sets/p/main/latest");
            expect(requests[0].body).toEqual({ name: "checkout-v2" });
        } finally {
            stop();
        }
    });

    it("clears a field with an empty string", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: {} }));
        try {
            await handleUpdateSet({ project: "p", branch: "main", selector: "latest", title: "" });
            expect(requests[0].body).toEqual({ title: "" });
        } finally {
            stop();
        }
    });
});

describe("handleGetTemplates", () => {
    it("GETs the templates.md raw text", async () => {
        const { requests, stop } = await stubServer(() => ({ status: 200, body: {}, text: "# Board templates" }));
        try {
            const out = await handleGetTemplates();
            expect(requests[0].path).toBe("/api/boards/templates.md");
            expect(out).toBe("# Board templates");
        } finally {
            stop();
        }
    });
});
