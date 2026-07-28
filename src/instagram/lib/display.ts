import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliSection,
    truncateDisplay,
} from "@genesiscz/utils/table";
import pc from "picocolors";
import type { HighlightRef, InstagramProfile, PublicReelInfo, StoryReel } from "./types";
import { InstagramError } from "./types";

function formatCount(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }

    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }

    return String(value);
}

export function displayProfile(profile: InstagramProfile, reel?: PublicReelInfo): void {
    renderCliHeader(`@${profile.username}`, profile.fullName);

    const table = createBoxTable(["FIELD", "VALUE"]);
    table.push([pc.white("id"), pc.dim(profile.id)]);
    table.push([pc.white("followers"), formatCount(profile.followers)]);
    table.push([pc.white("following"), formatCount(profile.following)]);
    table.push([pc.white("posts"), formatCount(profile.posts)]);
    table.push([pc.white("highlights"), formatCount(profile.highlightCount)]);
    table.push([
        pc.white("private"),
        formatDotStatus(profile.isPrivate ? "err" : "ok", profile.isPrivate ? "yes" : "no"),
    ]);
    table.push([pc.white("verified"), profile.isVerified ? formatDotStatus("ok", "yes") : pc.dim("no")]);
    table.push([pc.white("professional"), profile.isProfessional ? formatDotStatus("ok", "yes") : pc.dim("no")]);

    if (reel) {
        table.push([
            pc.white("live story"),
            reel.hasPublicStory ? formatDotStatus("ok", "yes") : formatDotStatus("dim", "no"),
        ]);

        if (reel.storyExpiresAt) {
            table.push([pc.white("story expires"), pc.dim(reel.storyExpiresAt.toLocaleString())]);
        }

        if (reel.isLive) {
            table.push([pc.white("live now"), formatDotStatus("warn", "broadcasting")]);
        }
    }

    out.println(table.toString());

    if (profile.biography) {
        renderCliSection("Bio");
        out.println(pc.dim(profile.biography));
    }
}

export function displayHighlights(highlights: HighlightRef[]): void {
    renderCliHeader("Highlights", `${highlights.length} found`);

    const table = createBoxTable(["ID", "TITLE"]);
    for (const highlight of highlights) {
        table.push([pc.dim(highlight.id), pc.white(truncateDisplay(highlight.title, 40))]);
    }
    out.println(table.toString());
}

export function displayReels(reels: StoryReel[]): void {
    const total = reels.reduce((sum, reel) => sum + reel.items.length, 0);
    renderCliHeader("Stories", `${total} item${total === 1 ? "" : "s"}`);

    const table = createBoxTable(["WHEN", "TYPE", "SIZE", "EXPIRES"]);
    for (const reel of reels) {
        for (const item of reel.items) {
            table.push([
                pc.white(item.takenAt.toLocaleString()),
                item.isVideo ? pc.magenta("video") : pc.cyan("image"),
                pc.dim(`${item.width}x${item.height}`),
                item.expiresAt ? pc.dim(item.expiresAt.toLocaleString()) : pc.dim("—"),
            ]);
        }
    }
    out.println(table.toString());
}

/**
 * Turn an error into an explanation the user can act on. The session-required
 * case gets the most words because it is the one that looks like a bug and is
 * not: Instagram gates story media on viewer identity and returns an empty 200
 * to anonymous callers rather than an error.
 */
export function explainError(error: unknown): void {
    if (!(error instanceof InstagramError)) {
        out.log.error(error instanceof Error ? error.message : String(error));
        return;
    }

    switch (error.kind) {
        case "session-required":
            out.log.error("This needs a logged-in Instagram session.");
            out.log.info(
                "Instagram serves story and highlight media only to an identified viewer. Anonymous requests get an " +
                    "empty result with HTTP 200, not an error, so there is no way to read stories without a session."
            );
            out.log.info(`Set one with ${pc.cyan("export IG_SESSIONID=<sessionid cookie>")}, then re-run.`);
            out.log.warn("Use a throwaway account: this violates Instagram's ToS and puts you in the viewer list.");
            break;
        case "session-invalid":
            out.log.error("Instagram rejected the session cookie — it has most likely expired.");
            out.log.info("Log in again in a browser, copy the fresh `sessionid` cookie, and update IG_SESSIONID.");
            break;
        case "checkpoint":
            out.log.error("Instagram flagged the account with a checkpoint or challenge.");
            out.log.warn("This is account-level. Changing IP or proxy will not help and may worsen it.");
            out.log.info("Open Instagram in a browser with that account and clear the challenge.");

            if (error.challengeUrl) {
                out.log.info(`Challenge URL: ${pc.cyan(error.challengeUrl)}`);
            }

            out.log.warn("Do not re-run this command until it is cleared — retrying adds automation signal.");
            break;
        case "suspended":
            out.log.error("This Instagram account is SUSPENDED, not merely challenged.");
            out.log.warn("An SMS or email code will not clear a suspension — it needs an appeal.");

            if (error.challengeUrl) {
                out.log.info(`Appeal URL: ${pc.cyan(error.challengeUrl)}`);
            }

            break;
        case "feedback-required":
            out.log.error("Instagram returned `feedback_required` — the request looked automated.");
            out.log.warn("Scored against the ACCOUNT, so backing off does not clear the current block.");
            out.log.info("Wait it out (typically hours), and avoid re-running in a loop meanwhile.");
            break;
        case "please-wait":
            out.log.error("Instagram asked you to wait a few minutes before trying again.");
            out.log.info("A temporary throttle from too many recent requests. It clears on its own.");
            out.log.warn("It arrives as HTTP 401 with `require_login`, but your cookie is NOT the problem.");
            out.log.warn("Scoped to the caller, so a VPN or proxy will not clear it — only waiting will.");
            break;
        case "rate-limited":
            out.log.error("Rate limited by Instagram.");
            out.log.info("Back off for a while before retrying. This one is IP-level, unlike a checkpoint.");
            break;
        case "not-found":
            out.log.error("No such account.");
            break;
        case "private-account":
            out.log.error("That account is private.");
            break;
        default:
            out.log.error(error.message);
    }
}
