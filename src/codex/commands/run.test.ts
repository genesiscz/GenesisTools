import { expect, test } from "bun:test";
import { Command } from "commander";
import { nativeRunInvocation, registerRunCommand } from "./run";

test("run forwards native arguments through account-bound validation before starting processes", async () => {
    const program = new Command().exitOverride();
    registerRunCommand(program, { positional: true });
    await expect(
        program.parseAsync(["run", "work", "--", "--remote", "ws://another"], { from: "user" })
    ).rejects.toThrow("does not accept");
});

test("only a real run invocation asks for positional option parsing", () => {
    expect(nativeRunInvocation(["run", "work"])).toBe(true);
    expect(nativeRunInvocation(["-v", "start", "work"])).toBe(true);
    expect(nativeRunInvocation(["sessions", "-v"])).toBe(false);
    expect(nativeRunInvocation(["history", "run"])).toBe(false);
    expect(nativeRunInvocation([])).toBe(false);
});

test("registering run leaves the global -v usable after a sibling subcommand", async () => {
    // Regression: enablePositionalOptions() on the shared root made `tools codex <any> -v`
    // exit 1 with "unknown option '-v'" for every subcommand, not just run.
    const program = new Command().exitOverride().option("-v, --verbose", "Enable verbose logging");
    let verbose = false;
    program.command("sessions").action(() => {
        verbose = program.opts().verbose === true;
    });
    registerRunCommand(program, { positional: false });
    await program.parseAsync(["sessions", "-v"], { from: "user" });
    expect(verbose).toBe(true);
});
