import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { CHANNELS, notificationsConfig } from "@genesiscz/utils/notifications";
import { filePhoneDeviceStore, removePhoneDevice } from "@genesiscz/utils/notifications/channels/phone/devices";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

/** `tools notify phone …`: the phones that registered for push, the APNs key, and a test push. */
export function registerPhoneCommands(program: Command): void {
    const phone = program.command("phone").description("Push to the phones that registered with this Mac");

    phone
        .command("devices")
        .description("List the registered phones and how each is reached (APNs or a simulator)")
        .option("--json", "Print as JSON")
        .action((options: { json?: boolean }) => {
            const devices = filePhoneDeviceStore().list();

            if (options.json) {
                out.result(devices.map(({ publicKey: _key, ...device }) => device));
                return;
            }

            if (devices.length === 0) {
                out.println("No phone registered. Open the DevDashboard app against this Mac and allow notifications.");
                return;
            }

            renderCliHeader("Phones", `${devices.length} registered`);
            const table = createBoxTable(["ID", "NAME", "ROUTE", "SEEN"]);

            for (const device of devices) {
                const route =
                    device.route.kind === "apns"
                        ? `apns ${device.route.environment} ${device.route.token.slice(0, 8)}…`
                        : `simulator ${device.route.udid}`;
                table.push([device.id, device.name, route, device.seenAt]);
            }

            out.println(table.toString());
        });

    phone
        .command("remove <id>")
        .description("Forget one registered phone")
        .action(async (id: string) => {
            const removed = await removePhoneDevice(filePhoneDeviceStore(), id);
            removed ? out.println(`Removed ${id}.`) : out.error(`No phone ${id}.`);
            process.exitCode = removed ? 0 : 1;
        });

    phone
        .command("apns")
        .description("Set the APNs key a real phone needs (the .p8 file, its key id and the Apple team id)")
        .requiredOption("--team <id>", "the Apple Developer team id")
        .requiredOption("--key-id <id>", "the key id App Store Connect shows beside the key")
        .requiredOption("--key-path <file>", "the AuthKey_<id>.p8 file")
        .action(async (options: { team: string; keyId: string; keyPath: string }) => {
            const keyPath = resolve(options.keyPath);

            if (!existsSync(keyPath)) {
                out.error(`${keyPath} does not exist.`);
                process.exitCode = 1;
                return;
            }

            const { channels } = await notificationsConfig.load();
            await notificationsConfig.setGlobalChannel("phone", {
                ...channels.phone,
                apns: {
                    teamId: options.team,
                    keyId: options.keyId,
                    keyPath,
                },
            });
            out.println(`APNs key set (team ${options.team}, key ${options.keyId}).`);
        });

    phone
        .command("test")
        .description("Send one test push to every registered phone, even while the channel is switched off")
        .option("--title <title>", "the title", "GenesisTools")
        .option("--message <text>", "the body", "Push to this phone works.")
        .action(async (options: { title: string; message: string }) => {
            if (filePhoneDeviceStore().list().length === 0) {
                out.error("No phone registered. Open the DevDashboard app against this Mac and allow notifications.");
                process.exitCode = 1;
                return;
            }

            const { channels } = await notificationsConfig.load();
            const receipt = await CHANNELS.phone.post(
                { app: "notify", title: options.title, message: options.message, id: `notify-test-${Date.now()}` },
                { ...channels.phone, enabled: true }
            );
            out.println(`${receipt.ok ? pc.green("sent") : pc.red("not sent")}: ${receipt.detail ?? ""}`);

            if (!channels.phone.enabled) {
                out.println(
                    pc.dim(
                        `The channel is off; switch it on with ${suggestCommand("tools notify", { replaceCommand: ["config"] })}`
                    )
                );
            }

            process.exitCode = receipt.ok ? 0 : 1;
        });
}
