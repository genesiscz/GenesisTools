import { describe, expect, it } from "bun:test";
import { Command } from "commander";

describe("task dashboard open --session (eval2 bug #8)", () => {
    it("binds --session to parent program.opts, not subcommand action opts", () => {
        const program = new Command();
        program.option("--session <name>", "Session name");

        const dashboard = program.command("dashboard");
        let actionOpts: { qr?: boolean; session?: string } | undefined;
        let globalSession: string | undefined;

        dashboard
            .command("open")
            .option("--no-qr", "Skip QR")
            .action((opts: { qr?: boolean }) => {
                actionOpts = opts;
                globalSession = program.opts<{ session?: string }>().session;
            });

        program.exitOverride();
        program.parse(["node", "task", "--session", "eval2-storm", "dashboard", "open", "--no-qr"]);

        expect(globalSession).toBe("eval2-storm");
        expect(actionOpts?.session).toBeUndefined();
        expect(actionOpts?.qr).toBe(false);
    });
});
