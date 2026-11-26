import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Executor } from "@genesiscz/utils/cli";
import type { ServiceManager, ShareServerConfig } from "@genesiscz/utils/genesis-tools/publish/store";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

export interface ServiceUnitInput {
    server: ShareServerConfig;
    checkoutDir: string;
    bunPath: string;
    home: string;
}

export interface ServiceInstaller {
    readonly manager: ServiceManager;
    render(input: ServiceUnitInput): string;
    installCommands(input: ServiceUnitInput & { unitFile: string }): string[][];
    install(input: ServiceUnitInput): Promise<{ unitFile: string }>;
    restart(server: ShareServerConfig): Promise<void>;
    stop(server: ShareServerConfig): Promise<void>;
    isActive(server: ShareServerConfig): Promise<boolean>;
}

export type ServiceRunner = (argv: string[]) => Promise<void>;

const executor = new Executor({ label: "publish-service" });

export const runServiceCommand: ServiceRunner = async (argv) => {
    const result = await executor.exec(argv, { timeout: { ms: 90_000, reason: "install or control a service" } });
    if (!result.success) {
        throw new Error(`${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`);
    }
};

export async function writeServiceFile(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    atomicWriteFileSync(path, text, { mode: 0o644 });
}
