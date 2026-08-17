#!/usr/bin/env bun
/**
 * tools spotify — everything about a Spotify listening life, from data that is already yours.
 *
 * Two sources feed this. The Extended Streaming History export holds every play since the
 * account was created and is the only place personal play counts exist. The browser harvest
 * holds the Liked Songs library with each track's GLOBAL stream count, which the public Web
 * API cannot return at all. Genres come from neither: MusicBrainz and Last.fm supply those.
 *
 *   tools spotify analytics summary
 *   tools spotify analytics top artists --year 2025
 *   tools spotify analytics compat me kaja --timeline
 *   tools spotify play run
 *   tools spotify ui
 */
import { registerAnalytics } from "@app/spotify/commands/analytics";
import { registerCompat } from "@app/spotify/commands/compat";
import { registerLibrary } from "@app/spotify/commands/library";
import { registerPipeline } from "@app/spotify/commands/pipeline";
import { registerPlay } from "@app/spotify/commands/play";
import { registerProfiles } from "@app/spotify/commands/profiles";
import { registerUiCommand } from "@app/spotify/commands/ui";
import { enhanceHelp, runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

const program = new Command();

program
    .name("spotify")
    .description("Spotify listening analytics from your own export, plus cross-library compatibility")
    .showHelpAfterError()
    .addHelpText(
        "after",
        `
${pc.bold("Getting started")}
  tools spotify profile add me --history ~/Spotify/streaming-history --data ~/Spotify/data
  tools spotify analytics summary
  tools spotify analytics top artists --year 2026

${pc.bold("Two people")}
  tools spotify profile add kaja --history ~/Downloads/kaja-export
  tools spotify analytics compat me kaja
  tools spotify analytics compat me kaja --timeline --bucket quarter
  tools spotify analytics blend me kaja --top 40

${pc.bold("Yourself, over time")}
  tools spotify analytics dna
  tools spotify analytics shift 2019 2026

${pc.bold("Hear it")}
  tools spotify play plan --windows 10:3,20:3,30:3 --tracks ~/Spotify/candidates.json
  tools spotify play run --resume

${pc.bold("In a browser")}
  tools spotify ui

${pc.bold("Notes")}
  A play means 30 seconds or more, matching Spotify's own royalty threshold.
  'plays' is always personal. The library's 'playcount' is global and never mixed in.
  Genres come from MusicBrainz and Last.fm; Spotify exposes none anywhere.
`
    );

registerProfiles(program);

const analytics = program
    .command("analytics")
    .description("every report over your listening history and library — run bare for the list");
registerAnalytics(analytics);
registerLibrary(analytics);
registerCompat(analytics);

registerPipeline(program);
registerPlay(program);
registerUiCommand(program);

enhanceHelp(program);

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "spotify" });
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        await out.flush();
        process.exit(1);
    }
}

await main();
