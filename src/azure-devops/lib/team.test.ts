import { describe, expect, test } from "bun:test";
import { resolveTeam } from "@app/azure-devops/lib/team";
import type { AzureConfig } from "@app/azure-devops/types";

const BASE: AzureConfig = {
    org: "https://dev.azure.com/contoso",
    project: "Widgets",
    projectId: "00000000-0000-0000-0000-000000000000",
    apiResource: "499b84ac-1321-427f-aa17-267ca6975798",
};

describe("resolveTeam", () => {
    test("the explicit flag wins over config", () => {
        expect(resolveTeam({ ...BASE, team: "Team A" }, "Team B")).toEqual({ team: "Team B", source: "flag" });
    });

    test("falls back to config when no flag is passed", () => {
        expect(resolveTeam({ ...BASE, team: "Team A" }, undefined)).toEqual({ team: "Team A", source: "config" });
    });

    test("a blank flag does not shadow config", () => {
        expect(resolveTeam({ ...BASE, team: "Team A" }, "   ")).toEqual({ team: "Team A", source: "config" });
    });

    test("returns null when neither is set, which callers treat as 'no narrowing'", () => {
        expect(resolveTeam(BASE, undefined)).toBeNull();
    });
});
