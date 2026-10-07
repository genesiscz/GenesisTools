import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";

export async function cmdPing(): Promise<void> {
    try {
        const backend = await getJenkinsBackend();
        await backend.api("api/json?tree=mode");
        out.println(`UP ${new Date().toISOString()}`);
    } catch (error) {
        out.println(`DOWN ${new Date().toISOString()} (${error instanceof Error ? error.message : String(error)})`);
    }
}

export function registerPing(jenkins: Command): void {
    jenkins
        .command("ping")
        .description("One logged GET; prints UP/DOWN (never throws)")
        .action(async () => {
            await cmdPing();
        });
}
