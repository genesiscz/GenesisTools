import { spawnSync } from "node:child_process";
import { isInteractive } from "@app/utils/cli";
import pc from "picocolors";
import { getBackend } from "./backend";

export interface OfferInstallOpts {
    tool: string;
    command: string;
    why: string;
}

export function buildInstallPrompt(opts: OfferInstallOpts): string {
    return `Install ${pc.bold(opts.tool)} - ${opts.why}\n  ${pc.dim(`Will run: ${opts.command}`)}`;
}

export async function offerInstall(opts: OfferInstallOpts): Promise<boolean> {
    if (!isInteractive()) {
        return false;
    }

    const backend = getBackend();
    const ok = await backend.confirm({ message: buildInstallPrompt(opts) });

    if (!ok) {
        return false;
    }

    const [command, ...args] = opts.command.trim().split(/\s+/);
    if (!command) {
        backend.log.error("Install command is empty.");
        return false;
    }

    const spinner = backend.spinner();
    spinner.start(`Installing ${opts.tool}...`);
    const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });

    if (result.status === 0) {
        spinner.stop(`${opts.tool} installed`);
        return true;
    }

    spinner.stop(`Install failed: ${result.stderr || "unknown error"}`);
    return false;
}
