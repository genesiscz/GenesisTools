import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAdoConfig } from "@app/azure-devops/lib/ado-configure";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { SafeJSON } from "@genesiscz/utils/json";

function existingConfig(): AzureConfigWithTimeLog {
    return {
        org: "contoso",
        project: "Widgets",
        projectId: "00000000-0000-0000-0000-000000000001",
        apiResource: "499b84ac-0000-0000-0000-000000000000",
        team: "Payments Team",
        orgId: "00000000-0000-0000-0000-000000000002",
        timelog: { functionsUrl: "https://example.invalid/api", functionsKey: "kept-secret" },
    } as AzureConfigWithTimeLog;
}

/**
 * Regression test: PR #333 review t9. `saveAdoConfig` wrote the incoming object
 * over the whole file, so re-running `configure` with a URL that carries no
 * team silently dropped the configured team — and, worse, the `timelog` block,
 * which holds the Azure Functions key. That key exists nowhere else.
 */
describe("saveAdoConfig", () => {
    test("keeps settings the incoming config cannot carry", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));
        writeFileSync(join(dir, "config.json"), SafeJSON.stringify(existingConfig(), null, 2));

        const path = saveAdoConfig(
            {
                org: "contoso",
                project: "Widgets",
                projectId: "00000000-0000-0000-0000-000000000001",
                apiResource: "499b84ac-0000-0000-0000-000000000000",
            },
            dir
        );

        const saved = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as AzureConfigWithTimeLog;

        expect(saved.team).toBe("Payments Team");
        expect(saved.timelog?.functionsKey).toBe("kept-secret");
        expect(saved.orgId).toBe("00000000-0000-0000-0000-000000000002");
    });

    test("a team in the new config replaces the old one", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));
        writeFileSync(join(dir, "config.json"), SafeJSON.stringify(existingConfig(), null, 2));

        const path = saveAdoConfig(
            {
                org: "contoso",
                project: "Widgets",
                projectId: "00000000-0000-0000-0000-000000000001",
                apiResource: "499b84ac-0000-0000-0000-000000000000",
                team: "Billing Team",
            },
            dir
        );

        const saved = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as AzureConfigWithTimeLog;

        expect(saved.team).toBe("Billing Team");
        expect(saved.timelog?.functionsKey).toBe("kept-secret");
    });

    /**
     * Pointing configure at a different project must not leave the previous
     * project's identifiers merged into the new one.
     */
    test("switching project overwrites the project identity rather than merging it", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));
        writeFileSync(join(dir, "config.json"), SafeJSON.stringify(existingConfig(), null, 2));

        const path = saveAdoConfig(
            {
                org: "fabrikam",
                project: "Gadgets",
                projectId: "00000000-0000-0000-0000-0000000000ff",
                apiResource: "499b84ac-0000-0000-0000-000000000000",
            },
            dir
        );

        const saved = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as AzureConfigWithTimeLog;

        expect(saved.org).toBe("fabrikam");
        expect(saved.project).toBe("Gadgets");
        expect(saved.projectId).toBe("00000000-0000-0000-0000-0000000000ff");
    });

    test("writes a fresh config when none exists", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));

        const path = saveAdoConfig(
            {
                org: "contoso",
                project: "Widgets",
                projectId: "00000000-0000-0000-0000-000000000001",
                apiResource: "499b84ac-0000-0000-0000-000000000000",
            },
            dir
        );

        const saved = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as AzureConfigWithTimeLog;

        expect(saved.org).toBe("contoso");
        expect(saved.team).toBeUndefined();
    });
});
