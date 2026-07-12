import { appendFileSync } from "node:fs";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import type { APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

/** Server-state helpers for the dual-verify pattern (UI action → API assertion), modeled on
 *  vitrinka's e2e idiom: drive the UI with Playwright, re-read truth via the REST API. */

export interface TestCard {
    id: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    payload: Record<string, unknown>;
}

export interface TestBoardDoc {
    cards: TestCard[];
    edges: Array<{ id: number; fromCard: number; toCard: number | null; toX: number; toY: number }>;
    strokes: Array<{ id: number; cardId: number | null; path: number[][] }>;
    annotations: Array<{ id: number; cardId: number; status: string; prompt: string }>;
    questions: Array<{ id: number; answer: string[] | null; staged: boolean }>;
}

let seq = 0;

/** POST /api/boards with a unique slug; returns the slug. */
export async function freshBoard(request: APIRequestContext, prefix: string): Promise<string> {
    seq += 1;
    const slug = `pw-${prefix}-${Date.now().toString(36)}-${seq}`;
    const res = await request.post("/api/boards", { data: { slug, title: `Playwright ${prefix}` } });
    expect(res.status(), `create board ${slug}`).toBe(201);

    const slugsFile = env.get("PW_RUN_SLUGS_FILE");

    if (slugsFile) {
        appendFileSync(slugsFile, `${slug}\n`);
    }

    return slug;
}

export async function boardDoc(request: APIRequestContext, slug: string): Promise<TestBoardDoc> {
    const res = await request.get(`/api/boards/${slug}`);
    expect(res.ok(), `GET board ${slug}`).toBeTruthy();
    return SafeJSON.parse(await res.text(), { strict: true }) as TestBoardDoc;
}

/** API-seed a card so specs don't depend on UI creation flows they aren't testing. */
export async function seedCard(
    request: APIRequestContext,
    slug: string,
    card: Partial<TestCard> & { kind: string }
): Promise<TestCard> {
    const res = await request.post(`/api/boards/${slug}/cards`, {
        data: { x: 100, y: 100, w: 240, h: 140, payload: {}, ...card },
    });
    expect(res.ok(), `seed ${card.kind} card on ${slug}`).toBeTruthy();
    return SafeJSON.parse(await res.text(), { strict: true }) as TestCard;
}

export async function seedNote(
    request: APIRequestContext,
    slug: string,
    text: string,
    at: { x: number; y: number } = { x: 100, y: 100 }
): Promise<TestCard> {
    return seedCard(request, slug, { kind: "note", ...at, w: 200, h: 120, payload: { text } });
}

export async function seedTextCard(
    request: APIRequestContext,
    slug: string,
    md: string,
    at: { x: number; y: number } = { x: 400, y: 100 }
): Promise<TestCard> {
    return seedCard(request, slug, { kind: "text", ...at, w: 280, h: 160, payload: { md } });
}
