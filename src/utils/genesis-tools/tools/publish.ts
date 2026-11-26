import { toolCommand } from "@genesiscz/utils/cli/tool-command";

export function shareServerSetupCommand(
    role?: "server" | "client" | "both",
    values: { url?: string; code?: string; server?: string } = {}
): string {
    const args = role ? ["--role", role] : [];
    for (const [flag, value] of Object.entries(values)) {
        if (value) {
            args.push(`--${flag}`, value);
        }
    }

    return toolCommand("dev-dashboard share-server setup", ...args);
}

export function shareServerPairCommand(): string {
    return toolCommand("dev-dashboard share-server pair");
}

export function shareServerServeCommand(name?: string): string {
    return toolCommand("dev-dashboard share-server serve", ...(name ? ["--server", name] : []));
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
