import { describe, expect, test } from "bun:test";
import { parseQueryDate, parseShowQuery } from "./query";

describe("parseShowQuery", () => {
    test("parses conversation with NAME from DATE to DATE", () => {
        const q = parseShowQuery("conversation with Ussov Stanislav from 2026-08-06 to 2026-08-06");
        expect(q.withName).toBe("Ussov Stanislav");
        expect(q.from?.getFullYear()).toBe(2026);
        expect(q.from?.getMonth()).toBe(7);
        expect(q.from?.getDate()).toBe(6);
        expect(q.to?.getFullYear()).toBe(2026);
        expect(q.to?.getMonth()).toBe(7);
        expect(q.to?.getDate()).toBe(6);
        expect(q.to && q.from ? q.to.getTime() > q.from.getTime() : false).toBe(true);
    });

    test("parses a topic title leftover", () => {
        const q = parseShowQuery("Nabídky 2.0 - Nacenění");
        expect(q.topic).toBe("Nabídky 2.0 - Nacenění");
        expect(q.withName).toBeUndefined();
    });

    test("passes a thread id through", () => {
        const id = "19:866a5869-13fd-4f15-9063-70b6dbf0e651_8a0d9825-0a4a-4be1-91e8-c2e1fa883c1e@unq.gbl.spaces";
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
