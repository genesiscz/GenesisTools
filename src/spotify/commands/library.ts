/**
 * The reports that need the harvested library: what is saved, what is played, and how the
 * two disagree.
 */
import { common, emit, limitOf } from "@app/spotify/commands/_shared";
import type { CommonOpts } from "@app/spotify/lib/context";
import { auditReport, gemsReport, mainstreamReport, savesReport } from "@app/spotify/lib/reports/library";
import { renderAudit, renderGems, renderMainstream, renderSaves } from "@app/spotify/render/library";
import type { Command } from "commander";

export function registerLibrary(program: Command): void {
    common(
        program.command("audit").description("liked but never played, played but never liked, and duplicate saves")
    ).action((o: CommonOpts) => {
        emit(o.json, auditReport(o), (r) => renderAudit(r, limitOf(o)));
    });

    common(
        program
            .command("gems")
            .description("your favourites the rest of the world has not found")
            .option("--min <n>", "at least this many personal plays", "8")
            .option("--max-global <n>", "global stream ceiling", "1000000")
    ).action((o: CommonOpts & { min?: string; maxGlobal?: string }) => {
        emit(o.json, gemsReport(o), (r) => renderGems(r, limitOf(o)));
    });

    common(
        program
            .command("mainstream")
            .description("how popular your taste is, and whether it is drifting")
            .option("--min <n>", "artists need this many plays to rank", "30")
    ).action((o: CommonOpts & { min?: string }) => {
        emit(o.json, mainstreamReport(o), renderMainstream);
    });

    common(program.command("saves").description("when you added things to the library, and how fast it grew")).action(
        (o: CommonOpts) => {
            emit(o.json, savesReport(o), renderSaves);
        }
    );
}
