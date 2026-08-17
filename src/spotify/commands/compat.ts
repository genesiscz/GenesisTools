/**
 * The two-person door: compatibility, a shared playlist, and what to play them next.
 */
import { common, emit, limitOf } from "@app/spotify/commands/_shared";
import type { CommonOpts } from "@app/spotify/lib/context";
import {
    blendReport,
    type CompatOpts,
    compatReport,
    compatTimelineReport,
    giftReport,
} from "@app/spotify/lib/reports/compat";
import { renderBlend, renderCompat, renderCompatTimeline, renderGift } from "@app/spotify/render/compat";
import type { Command } from "commander";

export function registerCompat(program: Command): void {
    common(
        program
            .command("compat <a> <b>")
            .alias("compare")
            .description("taste compatibility between two profiles, with the parts that make it up")
            .option("--timeline", "score each period separately instead of one overall number")
            .option("-b, --bucket <size>", "timeline bucket: month | quarter | year", "quarter")
            .option("--min-plays <n>", "skip timeline buckets thinner than this on either side", "40")
    ).action((aName: string, bName: string, o: CompatOpts) => {
        if (o.timeline) {
            emit(o.json, compatTimelineReport(aName, bName, o), renderCompatTimeline);

            return;
        }

        emit(o.json, compatReport(aName, bName, o), (r) => renderCompat(r, limitOf(o, 15)));
    });

    common(
        program
            .command("blend <a> <b>")
            .description("a shared playlist: songs both of you actually play, best matches first")
            .option("--min <n>", "each side needs this many plays of the song", "2")
    ).action((aName: string, bName: string, o: CommonOpts & { min?: string }) => {
        emit(o.json, blendReport(aName, bName, o), (r) => renderBlend(r, limitOf(o, 30)));
    });

    common(
        program
            .command("gift <from> <to>")
            .description("what to play them next: your tracks they have never heard, scored by their taste")
    ).action((fromName: string, toName: string, o: CommonOpts) => {
        emit(o.json, giftReport(fromName, toName, o), (r) => renderGift(r, limitOf(o, 25)));
    });
}
