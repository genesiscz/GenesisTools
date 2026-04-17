import type { Finding } from "@app/doctor/lib/types";
import { describe, expect, it } from "bun:test";
import { genericView } from "../generic-view";

describe("genericView", () => {
    it("renders one row per finding with sel + sev + title + size + note", () => {
        const findings: Finding[] = [
            { id: "a", analyzerId: "x", title: "one", severity: "safe", actions: [], reclaimableBytes: 1024 },
            { id: "b", analyzerId: "x", title: "two", severity: "cautious", actions: [], detail: "why" },
        ];
        const res = genericView({ findings, selected: new Set(["a"]), cursor: 0, viewportRows: 10 });
        expect(res.columns).toHaveLength(5);
        expect(res.rows).toHaveLength(2);
        expect(res.rows[0][0][0].text).toBe("[x]");
        expect(res.rows[1][0][0].text).toBe("[ ]");
        expect(res.total).toBe(2);
    });

    it("marks blocked findings with [-]", () => {
        const findings: Finding[] = [
            { id: "a", analyzerId: "x", title: "nope", severity: "blocked", actions: [] },
        ];
        const res = genericView({ findings, selected: new Set(), cursor: 0, viewportRows: 10 });
        expect(res.rows[0][0][0].text).toBe("[-]");
    });
});
