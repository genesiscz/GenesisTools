import { describe, expect, test } from "bun:test";
import { pickSessionByQuery } from "./pick-session";
import type { AgentSession } from "./types";

function session(id: string, title: string): AgentSession {
    return {
        kind: "grok",
        sessionId: id,
        cwd: "/Users/me/Projects/shop",
        title,
        mtime: new Date("2026-09-03T10:00:00.000Z"),
        filePath: `/tmp/${id}.json`,
    };
}

const A = session("01a05cc5-0ecf-7d40-945e-977e45b3f935", "PRs merged into release/2026-09-03");
const B = session("01a05d17-c512-7dd2-abb6-e62d8c7d612a", "aws-costs");

describe("pickSessionByQuery", () => {
    test("matches a unique id prefix", () => {
        expect(pickSessionByQuery([A, B], "01a05cc5")?.sessionId).toBe(A.sessionId);
    });

    test("matches a unique title substring", () => {
        expect(pickSessionByQuery([A, B], "aws-costs")?.sessionId).toBe(B.sessionId);
    });

    test("returns undefined when two titles could match", () => {
        expect(pickSessionByQuery([A, B], "01a05")).toBeUndefined();
    });
});
