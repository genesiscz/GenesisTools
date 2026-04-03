import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { DEFAULT_WOL_PORT, readWakeupConfig } from "../config";
import { sendWakePacket } from "../lib/wol";
import { getDefaultInterface } from "../network";

function ensureValue<T>(value: T, message: string): T {
    if (p.isCancel(value)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    if (value === undefined || value === null) {
        p.cancel(message);
        process.exit(1);
    }

    if (typeof value === "string" && value.trim().length === 0) {
        p.cancel(message);
        process.exit(1);
    }

    return value;
}

export async function runSendFlow(storage: Storage): Promise<void> {
    p.intro("Send a magic packet");
    const config = await readWakeupConfig(storage);
    const iface = getDefaultInterface();

    if (iface) {
        p.note(`Using defaults from ${iface.name} (${iface.address})`, "Detected network");
    }

    const answers = await p.group(
        {
            mac: () =>
                p.text({
                    message: "Target MAC",
                    initialValue: config.client?.mac ?? iface?.mac ?? "",
                    placeholder: "01:23:45:67:89:ab",
                }),
            broadcast: () =>
                p.text({
                    message: "Broadcast",
                    initialValue: config.client?.broadcast ?? iface?.broadcast ?? "255.255.255.255",
                }),
            port: () =>
                p.text({
                    message: "UDP port",
                    initialValue: String(config.client?.wolPort ?? DEFAULT_WOL_PORT),
                    validate: (value) => {
                        const port = Number.parseInt(value ?? "", 10);
                        if (Number.isNaN(port) || port <= 0 || port > 65535) {
                            return "Enter a valid port (1-65535)";
                        }
                    },
                }),
            password: () =>
                p.text({
                    message: "SecureOn password (optional)",
                    placeholder: "hex",
                    initialValue: "",
                }),
        },
        {
            onCancel: () => {
                p.cancel("Cancelled");
                process.exit(0);
            },
        }
    );

    const mac = String(ensureValue(answers.mac, "MAC required")).trim();
    const broadcast = String(ensureValue(answers.broadcast, "Broadcast required")).trim();
    const port = Number.parseInt(String(ensureValue(answers.port, "Port required")), 10);
    const password =
        typeof answers.password === "string" && answers.password.trim().length > 0 ? answers.password : undefined;

    const spinner = p.spinner();
    spinner.start("Sending magic packet...");

    try {
        const result = await sendWakePacket({ mac, broadcast, port, password });
        spinner.stop(`Magic packet sent to ${result.mac} via ${result.broadcast}:${result.port}`);
    } catch (error) {
        spinner.stop("Send failed");
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    p.outro("Done");
}

export function registerSendCommand(program: Command, storage: Storage): void {
    program
        .command("send")
        .description("Send a Wake-on-LAN packet with guided prompts")
        .action(async () => {
            await runSendFlow(storage);
        });
}
