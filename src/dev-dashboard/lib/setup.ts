import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { formatHostsList, parseHostsList } from "@app/dev-dashboard/lib/allowed-hosts";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import * as p from "@clack/prompts";

async function promptAllowedHosts(current: string[]): Promise<string[] | null> {
    const input = await p.text({
        message: "Comma-delimited hostnames:",
        initialValue: formatHostsList(current),
        placeholder: "dev-dashboard.example.com",
        validate: (val) => {
            const hosts = parseHostsList(val ?? "");

            if (hosts.length === 0) {
                return "Enter at least one valid hostname";
            }
        },
    });

    if (p.isCancel(input)) {
        return null;
    }

    return parseHostsList(input);
}

export async function runFirstTimeSetup(): Promise<void> {
    const config = await getConfig();

    if (config.allowedHosts.length > 0) {
        return;
    }

    const want = await p.confirm({
        message:
            "Would you like to configure custom hostnames for the dev dashboard? (for LAN/tunnel access — Vite rejects requests from unregistered hostnames when served on 0.0.0.0)",
    });

    if (p.isCancel(want) || !want) {
        return;
    }

    const allowedHosts = await promptAllowedHosts([]);

    if (!allowedHosts) {
        return;
    }

    await saveConfig({ ...config, allowedHosts });
    p.log.success(`Saved allowed hosts: ${formatHostsList(allowedHosts)}`);
}

export async function runConfigure(): Promise<void> {
    if (!isInteractive()) {
        p.log.error("`configure` needs a TTY.");
        p.log.error(suggestCommand("tools dev-dashboard configure"));
        process.exitCode = 1;
        return;
    }

    p.intro("dev-dashboard configure");

    const config = await getConfig();
    const currentLabel =
        config.allowedHosts.length > 0 ? formatHostsList(config.allowedHosts) : "(none — Vite allows all in dev)";

    p.log.info(`Current allowed hosts: ${currentLabel}`);

    const input = await p.text({
        message: "Allowed hostnames (comma-delimited, empty to allow all):",
        initialValue: formatHostsList(config.allowedHosts),
        placeholder: "dev-dashboard.example.com",
    });

    if (p.isCancel(input)) {
        p.cancel("Cancelled.");
        return;
    }

    const allowedHosts = parseHostsList(input);
    await saveConfig({ ...config, allowedHosts });
    p.outro(
        allowedHosts.length > 0
            ? `Saved allowed hosts: ${formatHostsList(allowedHosts)}`
            : "Cleared allowed hosts — Vite allows all in dev mode."
    );
}
