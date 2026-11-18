import { expect, spyOn, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { appNeedFixture } from "@genesiscz/utils/macos/testing/app-need";
import { Command } from "commander";
import { registerGateCommands } from "./index";

test("gate status prints the missing approval method and its fix only when the need fails", async () => {
    const printed = spyOn(out, "println").mockImplementation(() => {});
    try {
        for (const [env, status] of [
            [appNeedFixture(), "the installed build does not answer gate.approve. Run `fixture-build`."],
            [appNeedFixture({ methods: ["gate.approve"] }), "GenesisTools.app RPC installed"],
            [appNeedFixture({ isTest: true }), "a test process never reaches GenesisTools.app"],
        ] as const) {
            const cli = new Command();
            registerGateCommands(cli, env);
            await cli.parseAsync(["gate", "status"], { from: "user" });
            const lines = printed.mock.calls.flat().join("\n");
            expect(lines).toContain(status);
            expect(lines.includes("fixture-build")).toBe(status.includes("fixture-build"));
            expect(lines).not.toContain("tools macos permissions build");
            printed.mockClear();
        }
    } finally {
        printed.mockRestore();
    }
});
