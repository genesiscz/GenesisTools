/** Which process readers this machine has; the one platform decision of the process layer. */
import { processTableAvailable } from "./libproc-table";

export type ProcessPlatform = "darwin" | "linux" | "win32" | "other";

export function processPlatform(): ProcessPlatform {
    const current = process.platform;
    return current === "darwin" || current === "linux" || current === "win32" ? current : "other";
}

/** macOS reads the kernel only when the libproc self-check passed; otherwise it falls back like any other OS. */
export function darwinKernel(): boolean {
    return processPlatform() === "darwin" && processTableAvailable();
}
