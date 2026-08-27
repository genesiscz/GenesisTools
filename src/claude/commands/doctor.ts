import type { Command } from "commander";

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description("Find running pinned sessions that silently bill the keychain account instead of their pin")
        .option(
            "--identity",
            "Also prove which account each stored token really bills, and flag two accounts that are secretly one. " +
                "Spends one 1-token completion per account, so it is opt-in"
        )
        .action(async (opts: { identity?: boolean }) => {
            const { doctorCommand } = await import("./doctor-impl");
            await doctorCommand({ identity: opts.identity });
        });
}
