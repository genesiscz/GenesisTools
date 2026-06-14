import { logger, out } from "@app/logger";
import { runTool, suggestCommand } from "@app/utils/cli";
import { renderQr } from "@app/utils/qr";
import { Command } from "commander";
import { buildTextPayload, buildWifiPayload, normalizeSecurity } from "./lib/payload";

interface TextOptions {
    small?: boolean;
}

interface WifiOptions {
    ssid?: string;
    pass?: string;
    security: string;
    hidden?: boolean;
    small?: boolean;
}

const program = new Command();

program
    .name("qr")
    .description("Render QR codes in the terminal for a URL/text or a WiFi network.")
    .argument("[text]", "URL or text to encode")
    .option("--small", "Compact rendering (half-height blocks)")
    .action(async (text: string | undefined, options: TextOptions) => {
        if (!text) {
            out.log.error("No text provided.");
            out.printlnErr(suggestCommand("tools qr", { add: ["<text>"] }));
            await out.flush();
            process.exit(1);
        }

        const payload = buildTextPayload(text);
        logger.debug({ payload }, "qr: rendering text payload");
        const matrix = renderQr(payload, { small: options.small ?? false });
        out.log.step(`QR for: ${text}`);
        out.print(matrix);
    });

program
    .command("wifi")
    .description("Render a QR for a WiFi network (phones can scan to join).")
    .requiredOption("--ssid <ssid>", "Network name (SSID)")
    .option("--pass <password>", "Network password (required unless --security nopass)")
    .option("--security <type>", "WPA | WEP | nopass", "WPA")
    .option("--hidden", "Mark the network as hidden (H:true)")
    .option("--small", "Compact rendering (half-height blocks)")
    .action(async (options: WifiOptions) => {
        let security: ReturnType<typeof normalizeSecurity>;
        try {
            security = normalizeSecurity(options.security);
        } catch (err) {
            out.log.error(err instanceof Error ? err.message : String(err));
            await out.flush();
            process.exit(1);
        }

        if (security !== "nopass" && !options.pass) {
            out.log.error(`--pass is required for ${security} networks (or use --security nopass).`);
            await out.flush();
            process.exit(1);
        }

        const ssid = options.ssid;
        if (!ssid) {
            out.log.error("--ssid is required.");
            await out.flush();
            process.exit(1);
        }

        const payload = buildWifiPayload({
            ssid,
            password: options.pass,
            security,
            hidden: options.hidden ?? false,
        });

        logger.debug({ ssid, security, hidden: options.hidden ?? false }, "qr: rendering wifi payload");
        const matrix = renderQr(payload, { small: options.small ?? false });
        out.log.step(`QR for WiFi network: ${ssid}`);
        out.print(matrix);
    });

await runTool(program, { tool: "qr" });
