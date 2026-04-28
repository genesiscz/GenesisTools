import { describe, expect, it } from "bun:test";
import type { Finding } from "@app/doctor/lib/types";
import { securityView } from "../security-view";

const filevaultOn: Finding = {
    id: "sec-fdesetup",
    analyzerId: "security",
    title: "FileVault: enabled",
    severity: "safe",
    actions: [],
    metadata: { check: "FileVault", passing: true },
};

const gatekeeperOff: Finding = {
    id: "sec-spctl",
    analyzerId: "security",
    title: "Gatekeeper: disabled",
    severity: "cautious",
    actions: [],
    metadata: { check: "Gatekeeper", passing: false },
};

describe("securityView", () => {
    it("returns one status row per check and empty actionable table", () => {
        const res = securityView({
            findings: [filevaultOn, gatekeeperOff],
            selected: new Set(),
            cursor: 0,
            viewportRows: 10,
        });

        expect(res.actionable.rows).toHaveLength(0);
        expect(res.actionable.findings).toHaveLength(0);

        expect(res.status).toHaveLength(2);
        expect(res.status[0].label).toBe("FileVault");
        expect(res.status[0].value).toContain("enabled");
        expect(res.status[1].label).toBe("Gatekeeper");
        expect(res.status[1].value).toContain("disabled");

        expect(res.total).toBe(2);
    });
});
