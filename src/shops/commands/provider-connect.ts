import logger from "@app/logger";
import { KosikAuthClient } from "@app/shops/api/shops/KosikAuthClient";
import { RohlikAuthClient } from "@app/shops/api/shops/RohlikAuthClient";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { isInteractive } from "@app/utils/cli";
import { password, text } from "@clack/prompts";
import type { Command } from "commander";

const log = logger.child({ component: "shops:provider-connect" });

interface CliOpts {
    email?: string;
    password?: string;
    cookie?: string;
    user?: number;
}

export function registerProviderConnectCommand(program: Command): void {
    program
        .command("provider-connect <shop>")
        .description(
            "Connect a shop account (rohlik.cz uses email/password; kosik.cz uses a paste-in 'sid' cookie)"
        )
        .option("--email <email>", "Email (rohlik only)")
        .option("--password <password>", "Password (rohlik only)")
        .option("--cookie <cookie>", "sid cookie value (kosik only)")
        .option("--user <id>", "User id (default 1)", (v) => Number.parseInt(v, 10))
        .action(async (shop: string, raw: CliOpts) => {
            const userId = raw.user ?? 1;
            const db = new ShopsDatabase();
            const repo = new UserProvidersRepository(db);
            try {
                if (shop === "rohlik.cz") {
                    let email = raw.email;
                    let pw = raw.password;
                    if (!email || !pw) {
                        if (!isInteractive()) {
                            throw new Error("rohlik requires --email and --password in non-interactive mode");
                        }

                        if (!email) {
                            email = String(await text({ message: "Rohlik email" }));
                        }

                        if (!pw) {
                            pw = String(await password({ message: "Rohlik password" }));
                        }
                    }

                    const client = new RohlikAuthClient();
                    await client.login(email, pw);
                    const profile = await client.getProfile();
                    const id = await repo.connect({
                        user_id: userId,
                        shop_origin: "rohlik.cz",
                        credentials: { type: "email-password", email, password: pw },
                        external_user_email: profile.email,
                    });
                    process.stdout.write(`✓ rohlik.cz connected as ${profile.email} (user_provider_id=${id})\n`);
                    return;
                }

                if (shop === "kosik.cz") {
                    let cookie = raw.cookie;
                    if (!cookie) {
                        if (!isInteractive()) {
                            throw new Error("kosik requires --cookie in non-interactive mode");
                        }

                        process.stdout.write(
                            "Open kosik.cz, log in normally, then DevTools → Application → Cookies → www.kosik.cz → copy the 'sid' value\n"
                        );
                        cookie = String(await text({ message: "Paste sid cookie value" }));
                    }

                    const cookieHeader = cookie.startsWith("sid=") ? cookie : `sid=${cookie}`;
                    const client = new KosikAuthClient({ sessionCookie: cookieHeader });
                    const profile = await client.getProfile();
                    const id = await repo.connect({
                        user_id: userId,
                        shop_origin: "kosik.cz",
                        credentials: { type: "session-cookie", cookie: cookieHeader },
                        external_user_email: profile.client.email,
                    });
                    process.stdout.write(
                        `✓ kosik.cz connected as ${profile.client.email} (user_provider_id=${id})\n`
                    );
                    return;
                }

                throw new Error(`Unsupported shop: ${shop}. Supported: rohlik.cz, kosik.cz`);
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : String(err) }, "provider-connect failed");
                process.stderr.write(`× ${err instanceof Error ? err.message : String(err)}\n`);
                process.exitCode = 1;
            } finally {
                db.close();
            }
        });
}
