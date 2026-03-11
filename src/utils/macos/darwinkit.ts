import logger from "@app/logger";
import type { DarwinKitOptions } from "@genesiscz/darwinkit";
import { DarwinKit } from "@genesiscz/darwinkit";

export type { DarwinKitOptions } from "@genesiscz/darwinkit";
export { DarwinKit, DarwinKitError } from "@genesiscz/darwinkit";

let _instance: DarwinKit | null = null;

export function getDarwinKit(options?: DarwinKitOptions): DarwinKit {
    if (!_instance) {
        _instance = new DarwinKit({
            timeout: 15_000,
            logger,
            logLevel: "warn",
            ...options,
        });
    }
    return _instance;
}

export function closeDarwinKit(): void {
    if (_instance) {
        _instance.close();
        _instance = null;
    }
}
