import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnnotationDto, CardDto } from "@app/dev-dashboard/contract/dto";
import { tarGz } from "@app/dev-dashboard/lib/boards/tar";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { findFreePort } from "@app/utils/net/free-port";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A minimal valid 1x1 transparent PNG — importSet only creates cards for files that
// parse as images (width > 0 && height > 0), so a real PNG header is required.
const ONE_PX_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
);

function toolText(res: Awaited<ReturnType<Client["callTool"]>>): string {
    return (res.content as { type: string; text: string }[])[0].text;
}

async function waitReady(base: string, deadline: number): Promise<void> {
    for (;;) {
        try {
            const res = await fetch(`${base}/api/boards`);
            if (res.ok) {
                return;
            }
        } catch {
            // server not up yet
        }
        if (Date.now() > deadline) {
            throw new Error(`dev-dashboard agent never became ready at ${base}`);
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}

describe("boards MCP tools (stdio e2e against a real agent-mode dev-dashboard)", () => {
    it("drives the full annotate → wait → work → attach → in_review loop", async () => {
        const home = mkdtempSync(join(tmpdir(), "boards-e2e-home-"));
        const port = await findFreePort();
        const base = `http://127.0.0.1:${port}`;

        const dashboardEntry = join(import.meta.dir, "../../dev-dashboard/index.ts");
        const proc = Bun.spawn([process.execPath, "run", dashboardEntry, "agent", "--port", String(port)], {
            env: { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: home },
            stdout: "ignore",
            stderr: "ignore",
        });

        try {
            await waitReady(base, Date.now() + 10_000);

            const project = "e2e-project";
            const branch = "main";

            const minted = (await fetch(`${base}/api/boards/sets`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({ project, branch }),
            }).then((r) => r.json())) as { key: string };

            const tarBytes = await tarGz([{ path: "shot.png", data: ONE_PX_PNG }]);
            const putRes = await fetch(`${base}/api/boards/sets/${project}/${branch}/${minted.key}/content`, {
                method: "PUT",
                body: new Uint8Array(tarBytes),
            });
            expect(putRes.ok).toBe(true);

            const slug = "e2e-board";
            const boardRes = await fetch(`${base}/api/boards`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({ slug, title: "E2E board", project }),
            });
            expect(boardRes.ok).toBe(true);

            const imported = (await fetch(`${base}/api/boards/${slug}/import-set`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({ project, branch, selector: "latest" }),
            }).then((r) => r.json())) as { cards: CardDto[] };
            expect(imported.cards.length).toBe(1);
            const cardId = imported.cards[0].id;

            const annotation = (await fetch(`${base}/api/boards/annotations`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({
                    board: slug,
                    cardId,
                    region: { x: 1, y: 2, w: 3, h: 4 },
                    intent: "fix",
                    prompt: "please fix the button",
                    status: "open",
                }),
            }).then((r) => r.json())) as AnnotationDto;

            const transport = new StdioClientTransport({
                command: process.execPath,
                args: ["run", join(import.meta.dir, "../index.ts"), "mcp"],
                env: { ...env.getProcessEnv(), BOARDS_BASE_URL: base },
            });
            const client = new Client({ name: "boards-e2e", version: "1.0.0" });
            await client.connect(transport);

            try {
                const tools = await client.listTools();
                const names = tools.tools.map((t) => t.name);
                for (const expected of [
                    "boards_list_boards",
                    "boards_list_sets",
                    "boards_get_set",
                    "boards_list_work",
                    "boards_get_annotation",
                    "boards_get_capsule",
                    "boards_set_status",
                    "boards_reply",
                    "boards_attach_after",
                    "boards_highlight",
                    "boards_wait_for_work",
                ]) {
                    expect(names).toContain(expected);
                }

                const waitRes = await client.callTool({
                    name: "boards_wait_for_work",
                    arguments: { board: slug, timeoutSec: 2 },
                });
                const waitBody = SafeJSON.parse(toolText(waitRes), { strict: true }) as {
                    work: Array<{ id: number; capsule: string }>;
                };
                expect(waitBody.work.length).toBe(1);
                expect(waitBody.work[0].id).toBe(annotation.id);
                expect(waitBody.work[0].capsule).toContain("№");

                await client.callTool({
                    name: "boards_set_status",
                    arguments: { id: annotation.id, status: "working" },
                });
                await client.callTool({
                    name: "boards_reply",
                    arguments: { id: annotation.id, text: "fixed, see v2" },
                });

                const tarBytesV2 = await tarGz([{ path: "shot.png", data: ONE_PX_PNG }]);
                const putV2 = await fetch(`${base}/api/boards/sets/${project}/${branch}/${minted.key}/content`, {
                    method: "PUT",
                    body: new Uint8Array(tarBytesV2),
                });
                expect(putV2.ok).toBe(true);

                await client.callTool({
                    name: "boards_attach_after",
                    arguments: { id: annotation.id, project, branch, selector: "latest", file: "shot.png" },
                });
                await client.callTool({
                    name: "boards_set_status",
                    arguments: { id: annotation.id, status: "in_review" },
                });

                const getRes = await client.callTool({
                    name: "boards_get_annotation",
                    arguments: { id: annotation.id },
                });
                const finalAnnotation = SafeJSON.parse(toolText(getRes), { strict: true }) as AnnotationDto;
                expect(finalAnnotation.status).toBe("in_review");
                expect(finalAnnotation.attempts.length).toBe(1);
            } finally {
                await client.close();
            }
        } finally {
            proc.kill();
        }
    }, 60000);

    it("drives a composed-board loop: compose → sections/scrape → ask/answer → dispatch → wait choice", async () => {
        const home = mkdtempSync(join(tmpdir(), "boards-e2e-compose-home-"));
        const port = await findFreePort();
        const base = `http://127.0.0.1:${port}`;

        const dashboardEntry = join(import.meta.dir, "../../dev-dashboard/index.ts");
        const proc = Bun.spawn([process.execPath, "run", dashboardEntry, "agent", "--port", String(port)], {
            env: { ...env.getProcessEnv(), GENESIS_TOOLS_HOME: home },
            stdout: "ignore",
            stderr: "ignore",
        });

        try {
            await waitReady(base, Date.now() + 10_000);

            const slug = "e2e-compose-board";
            const boardRes = await fetch(`${base}/api/boards`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: SafeJSON.stringify({ slug, title: "E2E compose board" }),
            });
            expect(boardRes.ok).toBe(true);

            const transport = new StdioClientTransport({
                command: process.execPath,
                args: ["run", join(import.meta.dir, "../index.ts"), "mcp"],
                env: { ...env.getProcessEnv(), BOARDS_BASE_URL: base },
            });
            const client = new Client({ name: "boards-compose-e2e", version: "1.0.0" });
            await client.connect(transport);

            try {
                const tools = await client.listTools();
                const names = tools.tools.map((t) => t.name);
                for (const expected of [
                    "boards_compose_board",
                    "boards_arrange",
                    "boards_update_cards",
                    "boards_scrape_board",
                    "boards_list_sections",
                    "boards_ask_board",
                    "boards_list_projects",
                    "boards_update_set",
                    "boards_get_templates",
                ]) {
                    expect(names).toContain(expected);
                }

                const composeRes = await client.callTool({
                    name: "boards_compose_board",
                    arguments: {
                        board: slug,
                        cards: [
                            { ref: "s", kind: "section", payload: { title: "Checkout" }, children: ["a", "b"] },
                            { ref: "a", kind: "text", payload: { md: "idea A" } },
                            { ref: "b", kind: "note", payload: { text: "note B" } },
                        ],
                        questions: [{ prompt: "pick one", options: ["x", "y"], cardRef: "a" }],
                    },
                });
                const composeBody = SafeJSON.parse(toolText(composeRes), { strict: true }) as {
                    cards: Array<{ id: number; ref?: string }>;
                    questions: number[];
                };
                expect(composeBody.cards.length).toBe(3);
                expect(composeBody.questions.length).toBe(1);
                const questionId = composeBody.questions[0];

                const sectionsRes = await client.callTool({
                    name: "boards_list_sections",
                    arguments: { board: slug },
                });
                const sectionsBody = SafeJSON.parse(toolText(sectionsRes), { strict: true }) as {
                    sections: Array<{ name: string; cards: number }>;
                };
                expect(sectionsBody.sections).toHaveLength(1);
                expect(sectionsBody.sections[0]).toMatchObject({ name: "Checkout", cards: 2 });

                const scrapeRes = await client.callTool({
                    name: "boards_scrape_board",
                    arguments: { board: slug, section: "Checkout" },
                });
                const scrapeBody = SafeJSON.parse(toolText(scrapeRes), { strict: true }) as { cards: unknown[] };
                expect(scrapeBody.cards.length).toBe(2);

                // Answering is a human/UI action over plain HTTP — boards_ask_board only CREATES
                // the question; there is no dedicated "answer" MCP tool.
                const answerRes = await fetch(`${base}/api/boards/questions/${questionId}/answer`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: SafeJSON.stringify({ answer: "x" }),
                });
                expect(answerRes.ok).toBe(true);

                const dispatchRes = await fetch(`${base}/api/boards/${slug}/dispatch`, { method: "POST" });
                expect(dispatchRes.ok).toBe(true);

                const waitRes = await client.callTool({
                    name: "boards_wait_for_work",
                    arguments: { board: slug, timeoutSec: 2 },
                });
                const waitBody = SafeJSON.parse(toolText(waitRes), { strict: true }) as {
                    choices?: Array<{ id: number; option: string[] }>;
                };
                expect(waitBody.choices?.length).toBe(1);
                expect(waitBody.choices?.[0].id).toBe(questionId);
                expect(waitBody.choices?.[0].option).toEqual(["x"]);
            } finally {
                await client.close();
            }
        } finally {
            proc.kill();
        }
    }, 60000);
});
