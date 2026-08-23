import type { Command } from "commander";

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description("Find running pinned sessions that silently bill the keychain account instead of their pin")
        .action(async () => {
            const { doctorCommand } = await import("./doctor-impl");
            await doctorCommand();
        });
}
