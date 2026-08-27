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

    /**
     * Regression test: PR #333 review t1, a defect introduced by the t9 fix.
     * Preserving supplemental settings is only correct WITHIN a project. Carried
     * across a project switch, the stale team is silently reused by
     * `iterations` / `sprint`, which then query a team that does not exist in
     * the new project, and the stale timelog endpoint points at the old one.
     */
    test("switching project drops the previous project's team and timelog", () => {
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

        expect(saved.team).toBeUndefined();
        expect(saved.timelog).toBeUndefined();
        expect(saved.orgId).toBeUndefined();
    });

    test("switching only the project within the same org also drops them", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));
        writeFileSync(join(dir, "config.json"), SafeJSON.stringify(existingConfig(), null, 2));

        const path = saveAdoConfig(
            {
                org: "contoso",
                project: "Gadgets",
                projectId: "00000000-0000-0000-0000-0000000000ff",
                apiResource: "499b84ac-0000-0000-0000-000000000000",
            },
            dir
        );

        const saved = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as AzureConfigWithTimeLog;

        expect(saved.team).toBeUndefined();
        expect(saved.timelog).toBeUndefined();
    });

    /**
     * Regression test: PR #333 review t13. readExistingConfig parsed with
     * { strict: true }, but NO_TEAM_MESSAGE tells users to add `"team"` to this
     * file by hand — so a `//` comment or a trailing comma made the parse throw,
     * the catch returned {}, and the whole config was overwritten. That destroys
     * timelog.functionsKey, which is the exact loss the merge was added to stop.
     */
    test("a hand-edited config with a comment and a trailing comma is still preserved", () => {
        const dir = mkdtempSync(join(tmpdir(), "ado-config-"));
        writeFileSync(
            join(dir, "config.json"),
            `{
    // added by hand, per the message the tool prints
    "org": "contoso",
    "project": "Widgets",
    "projectId": "00000000-0000-0000-0000-000000000001",
    "apiResource": "499b84ac-0000-0000-0000-000000000000",
    "team": "Payments Team",
    "timelog": { "functionsUrl": "https://example.invalid/api", "functionsKey": "kept-secret" },
}
`
        );

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
