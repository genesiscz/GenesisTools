import { afterEach, describe, expect, mock, test } from "bun:test";

const loadConfig = mock(() => null as unknown);

mock.module("@app/azure-devops/config", () => ({ loadConfig }));

const { requireAdoTimeLogConfig } = await import("@app/clarity/ui/src/server/ado-config");

const COMPLETE = {
    org: "sample-org",
    project: "Sample Project",
    orgId: "org-1",
    projectId: "proj-1",
    timelog: { functionsKey: "test-key", defaultUser: { userId: "user-1", displayName: "Sample User" } },
};

afterEach(() => {
    loadConfig.mockReset();
});

describe("requireAdoTimeLogConfig", () => {
    // The CLI helpers this replaces call process.exit(1), which inside a route would take the dev
    // server down mid-request and never answer the fetch. Every field must THROW instead.
    test.each([
        ["no config at all", null],
        ["a missing orgId", { ...COMPLETE, orgId: undefined }],
        ["a missing projectId", { ...COMPLETE, projectId: undefined }],
        ["a missing functions key", { ...COMPLETE, timelog: { defaultUser: COMPLETE.timelog.defaultUser } }],
        ["a missing default user", { ...COMPLETE, timelog: { functionsKey: "test-key" } }],
    ])("throws on %s", (_label, config) => {
        loadConfig.mockReturnValue(config);

        expect(() => requireAdoTimeLogConfig()).toThrow(/Settings/);
    });

    test("returns the config, user and api when every field is present", () => {
        loadConfig.mockReturnValue(COMPLETE);

        const result = requireAdoTimeLogConfig();

        expect(result.user.userId).toBe("user-1");
        expect(result.api).toBeDefined();
    });
});
