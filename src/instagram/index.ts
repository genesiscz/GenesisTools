#!/usr/bin/env bun

import { join } from "node:path";
import * as p from "@clack/prompts";
import { enhanceHelp, runTool, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";
import { fetchHighlightMedia, fetchHighlightTray, fetchProfile, fetchPublicReelInfo, fetchStories } from "./lib/api";
import { displayHighlights, displayProfile, displayReels, explainError } from "./lib/display";
import { downloadReels } from "./lib/download";
import { readSessionConfig, resolveSession, writeSessionConfig } from "./lib/session";
import type { StoryReel } from "./lib/types";

const { log } = logger.scoped("instagram");

const program = new Command()
    .name("instagram")
    .description("Inspect public Instagram profiles, and fetch stories with your own session");

interface SessionOptions {
    sessionCookie?: string;
}

async function resolveOrExplain(options: SessionOptions) {
    const session = await resolveSession(options.sessionCookie);

    if (session) {
        log.debug({ source: session.source, envKey: session.envKey }, "using instagram session");
    }

    return session;
}

program
    .command("profile <username>")
    .description("Public profile info — works with no session at all")
    .option("--json", "Emit JSON instead of a table")
    .action(async (username: string, options: { json?: boolean }) => {
        try {
            const profile = await fetchProfile(username);
            // Story existence is public even though the media is not.
            const reelInfo = await fetchPublicReelInfo(profile.id).catch((error) => {
                log.debug({ error }, "public reel info unavailable — showing profile without story state");
                return undefined;
            });

            if (options.json) {
                out.result({ ...profile, story: reelInfo });
                return;
            }

            displayProfile(profile, reelInfo);

            if (profile.highlightCount > 0) {
                out.log.info(
                    `${profile.highlightCount} highlights — ${pc.cyan(`tools instagram highlights ${username}`)}`
                );
            }
        } catch (error) {
            explainError(error);
            process.exit(1);
        }
    });

program
    .command("highlights <username>")
    .description("List highlight ids (anonymous) and titles (needs a session)")
    .option("-s, --session-cookie <cookie>", "Instagram sessionid cookie")
    .option("--json", "Emit JSON instead of a table")
    .action(async (username: string, options: SessionOptions & { json?: boolean }) => {
        try {
            const session = await resolveOrExplain(options);
            const profile = await fetchProfile(username);

            if (session) {
                const tray = await fetchHighlightTray(profile.id, session);

                if (options.json) {
                    out.result(tray);
                    return;
                }

                displayHighlights(tray);
                return;
            }

            // No session needed: the legacy public reel endpoint returns the full
            // tray with titles. Only the media inside each highlight is gated.
            const info = await fetchPublicReelInfo(profile.id);

            // This rides a pre-2020 `query_id` API that Instagram has largely
            // retired. If it starts answering 200 with a changed shape, an empty
            // list would read as "no highlights" — so cross-check against the
            // count from `web_profile_info`, which is on the durable REST surface.
            if (info.highlights.length === 0 && profile.highlightCount > 0) {
                log.warn(
                    { userId: profile.id, expected: profile.highlightCount },
                    "public reel endpoint returned no highlights but the profile reports some — endpoint likely changed"
                );
                out.log.warn(
                    `Instagram reports ${profile.highlightCount} highlights but the public endpoint returned none. ` +
                        "That endpoint is on a deprecated API generation and has probably changed shape."
                );
                out.log.info("This is a tool bug to fix, not an empty account.");
                process.exit(1);
            }

            if (options.json) {
                out.result(info.highlights);
                return;
            }

            displayHighlights(info.highlights);
            out.log.info(`Media needs a session — ${pc.cyan(`tools instagram highlight ${username} <id> --download`)}`);
        } catch (error) {
            explainError(error);
            process.exit(1);
        }
    });

program
    .command("stories <username>")
    .description("Fetch active stories (requires a session cookie)")
    .option("-s, --session-cookie <cookie>", "Instagram sessionid cookie")
    .option("-d, --download [dir]", "Download the media")
    .option("--json", "Emit JSON instead of a table")
    .action(async (username: string, options: SessionOptions & { download?: string | boolean; json?: boolean }) => {
        try {
            const session = await resolveOrExplain(options);
            const profile = await fetchProfile(username);
            const reels = await fetchStories(profile.id, session);

            await emitReels(reels, username, options);
        } catch (error) {
            explainError(error);
            process.exit(1);
        }
    });

program
    .command("highlight <username> <highlightId>")
    .description("Fetch one highlight's media (requires a session cookie)")
    .option("-s, --session-cookie <cookie>", "Instagram sessionid cookie")
    .option("-d, --download [dir]", "Download the media")
    .option("--json", "Emit JSON instead of a table")
    .action(
        async (
            username: string,
            highlightId: string,
            options: SessionOptions & { download?: string | boolean; json?: boolean }
        ) => {
            try {
                const session = await resolveOrExplain(options);
                const reels = await fetchHighlightMedia([highlightId], session);

                await emitReels(reels, username, options);
            } catch (error) {
                explainError(error);
                process.exit(1);
            }
        }
    );

program
    .command("session")
    .description("Show how the session cookie is being resolved, or point it at an env var")
    .option("--use-env <name>", "Store the NAME of an env var to read the cookie from (the cookie is never saved)")
    .action(async (options: { useEnv?: string }) => {
        if (options.useEnv) {
            await writeSessionConfig({ sessionIdEnv: options.useEnv });
            out.log.success(`Session cookie will be read from $${options.useEnv}`);
            return;
        }

        const config = await readSessionConfig();
        const session = await resolveSession();

        if (!session) {
            out.log.warn("No session cookie resolved — only anonymous commands will work.");
            out.log.info(
                `Set ${pc.cyan("IG_SESSIONID")}, or run ${pc.cyan("tools instagram session --use-env NAME")}.`
            );

            if (config.sessionIdEnv) {
                out.log.warn(`Config points at $${config.sessionIdEnv}, but that variable is unset or empty.`);
            }

            return;
        }

        out.log.success(
            `Session resolved from ${session.source}${session.envKey ? ` ($${session.envKey})` : ""} — ` +
                `${session.sessionId.slice(0, 6)}… (${session.sessionId.length} chars)`
        );
    });

async function emitReels(
    reels: StoryReel[],
    username: string,
    options: { download?: string | boolean; json?: boolean }
): Promise<void> {
    if (options.json) {
        out.result(reels);
        return;
    }

    displayReels(reels);

    if (!options.download) {
        out.log.info(suggestCommand("tools instagram", { add: ["--download"] }));
        return;
    }

    const dir = typeof options.download === "string" ? options.download : join(process.cwd(), `instagram-${username}`);
    const spinner = p.spinner();
    spinner.start("Downloading media");

    const results = await downloadReels(reels, dir, (done, total) => {
        spinner.message(`Downloading media (${done}/${total})`);
    });

    spinner.stop(`Downloaded ${results.length} file${results.length === 1 ? "" : "s"} to ${dir}`);

    // downloadReels only throws when EVERY item failed, so a partial failure would
    // otherwise read as a complete download that happened to be short.
    const expected = reels.reduce((sum, reel) => sum + reel.items.length, 0);
    if (results.length < expected) {
        out.log.warn(`${expected - results.length} of ${expected} items failed to download.`);
        log.warn({ expected, downloaded: results.length, dir }, "partial story download");
    }
}

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "instagram" });
    } catch (error) {
        explainError(error);
        process.exit(1);
    }
}

main();
