import type { DoctorReport, ExportResult } from "@app/spotify/lib/reports/pipeline";
import { heading, int, line, table } from "@app/spotify/render/text";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";

export function renderDoctor(r: DoctorReport): void {
    if (!r.profiles.length) {
        // `--data` is bracketed because it genuinely is optional: a history export alone
        // answers every listening report, and a second person hands over nothing else. Showing
        // both as required made the first step look like it needed a browser harvest first.
        line("no profiles configured. Start with:");
        line(pc.gray("  tools spotify profile add me --history <export dir> [--data <harvest dir>]"));
        line(pc.gray("  The history export alone is enough; --data adds the harvested library."));

        return;
    }

    renderCliHeader("Spotify Data Check", `default profile: ${r.defaultProfile}`);
    const t = createBoxTable(["PROFILE", "HISTORY", "LIBRARY", "GENRES"]);
    for (const p of r.profiles) {
        const pctTagged = p.libraryTracks ? Math.round((p.taggedTracks * 100) / p.libraryTracks) : 0;
        t.push([
            `${pc.white(p.name)} ${pc.dim(`(${p.label})`)}`,
            p.historyDir
                ? formatDotStatus(p.historyOk ? "ok" : "err", p.historyOk ? "ok" : "path missing")
                : formatDotStatus("warn", "none"),
            p.libraryPath ? formatDotStatus("ok", `${int(p.libraryTracks)} tracks`) : formatDotStatus("warn", "none"),
            p.taggedTracks
                ? formatDotStatus("ok", `${int(p.taggedTracks)} tagged (${pctTagged}%)`)
                : formatDotStatus("warn", "none"),
        ]);
    }

    line(t.toString());

    for (const p of r.profiles) {
        renderCliSection(p.name);
        if (!p.gaps.length) {
            line(pc.gray("    → complete"));
            continue;
        }

        for (const g of p.gaps) {
            line(pc.gray(`    → ${g}`));
        }
    }

    line("");
}

export function renderExportPreview(r: ExportResult, rows = 15): void {
    line(heading(`export preview · ${r.kind}`, `${int(r.objects.length)} rows · pass --out <path> to write`));
    line(
        table(
            r.headers.slice(0, 6).map((h) => ({ head: h, max: 28 })),
            r.rows
                .slice(0, rows)
                .map((row) => row.slice(0, 6).map((v) => (typeof v === "boolean" ? (v ? "yes" : "no") : v)))
        )
    );
}

export function renderHarvestGuide(): void {
    line(heading("harvesting the library"));
    line("");
    line(`  ${pc.bold("tools spotify harvest --auto")} does all of this for you against a browser already`);
    line("  signed in and started with remote debugging. The steps below are the manual path,");
    line("  and what --auto automates.");
    line("");
    line(`  The web player talks to ${pc.bold("api-partner.spotify.com/pathfinder/v2/query")}, which returns
  per-track global stream counts the public Web API has never exposed. The requests must
  come from a logged-in tab; there is no headless login path worth building.

  ${pc.bold("1.")} Open the browser's own DevTools on a signed-in open.spotify.com tab.
  ${pc.bold("2.")} Read the tokens out of a request the app already made:
       in the Network panel, filter on ${pc.bold("pathfinder")} and pick any pathfinder/v2/query
       (reload the tab if the list is empty); its request headers carry
       ${pc.bold("authorization")} and ${pc.bold("client-token")}
  ${pc.bold("3.")} Paste the function in ${pc.bold("src/spotify/page/setupGql.ts")} into the DevTools Console with those
       two values filled in, and run it. It installs window.__gql and returns
       totalLikedTracks, so a 401 is visible immediately.
  ${pc.bold("4.")} Run ${pc.bold("src/spotify/page/harvestLibrary.ts")} in the Console too, as
       ${pc.bold("copy(await (<payload>)())")}, which puts the result (about 1 MB) on the clipboard.
       Save it as ${pc.bold("sp_library_raw.json")} in the profile's data directory
       (tools spotify profile show prints the path).
  ${pc.bold("5.")} tools spotify build --profile me

  ${pc.yellow("The tokens and the sp_dc / sp_key cookies authorise the whole account.")}
  ${pc.yellow("Keep them in page memory. Never write them to a file, a log, or a chat message.")}

  Operation hashes rotate with every web-player release. When one starts failing, run
  ${pc.bold("src/spotify/page/extractOperations.ts")} to recover the whole catalogue from the live bundle:
  ${pc.bold("tools chrome-devtools eval --file src/spotify/page/extractOperations.ts --match open.spotify.com")}
`);
}
