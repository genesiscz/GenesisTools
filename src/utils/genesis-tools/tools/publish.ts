import { toolCommand } from "@genesiscz/utils/cli/tool-command";

export function shareServerSetupCommand(mode?: "server" | "client" | "both"): string {
    return toolCommand("dev-dashboard share-server setup", ...(mode ? ["--mode", mode] : []));
}

export function shareServerPairCommand(): string {
    return toolCommand("dev-dashboard share-server pair");
}

export function shareServerServeCommand(): string {
    return toolCommand("dev-dashboard share-server serve");
}

export function shareTargetAddCommand(input: { name?: string; url?: string; code?: string } = {}): string {
    const args = [input.name ?? "server", "--driver", "paired"];
    if (input.url) {
        args.push("--url", input.url);
    }

    if (input.code) {
        args.push("--code", input.code);
    }

    return toolCommand("dev-dashboard share target add", ...args);
}

export function artifactPublishCommand(target?: string): string {
    return toolCommand("artifact publish", ...(target ? [target] : []));
}
