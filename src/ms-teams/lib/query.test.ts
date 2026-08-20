import { describe, expect, test } from "bun:test";
import { parseQueryDate, parseShowQuery } from "./query";

describe("parseShowQuery", () => {
    test("parses conversation with NAME from DATE to DATE", () => {
        const q = parseShowQuery("conversation with Ada Lovelace from 2026-08-06 to 2026-08-06");
        expect(q.withName).toBe("Ada Lovelace");
        expect(q.from?.getFullYear()).toBe(2026);
        expect(q.from?.getMonth()).toBe(7);
        expect(q.from?.getDate()).toBe(6);
        expect(q.to?.getFullYear()).toBe(2026);
        expect(q.to?.getMonth()).toBe(7);
        expect(q.to?.getDate()).toBe(6);
        expect(q.to && q.from ? q.to.getTime() > q.from.getTime() : false).toBe(true);
        expect(q.topic).toBeUndefined();
    });

    test("parses a topic title leftover", () => {
        const q = parseShowQuery("Weekly planning");
        expect(q.topic).toBe("Weekly planning");
        expect(q.withName).toBeUndefined();
    });

    test("passes a thread id through", () => {
        const id = "19:11111111-2222-3333-4444-555555555555_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@unq.gbl.spaces";
        const q = parseShowQuery(id);
        expect(q.id).toBe(id);
    });

    test("parses dotted Czech dates", () => {
        const from = parseQueryDate("6. 8. 2026", "start");
        const to = parseQueryDate("6.8.2026", "end");
        expect(from?.getFullYear()).toBe(2026);
        expect(from?.getMonth()).toBe(7);
        expect(from?.getDate()).toBe(6);
        expect(to?.getHours()).toBe(23);
    });
});
