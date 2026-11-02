import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { buildLinks } from "../lib/operations";
import { parseIntArg, parseNumberArg, pickCategories, runOperation } from "./run";

function openUrl(url: string): void {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    logger.debug({ opener, url }, "waze opening a deep link");
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
}

export function registerAreaCommands(program: Command): void {
    program
        .command("alerts <area>")
        .description('Reports around a place, "lat,lon" or a box "south,west,north,east", nearest first')
        .option("--radius <km>", "Radius around a place (default 5)", parseNumberArg)
        .option(
            "--type [types]",
            "Only these report types (comma list): police, accident, hazard, jam, closure, camera, other"
        )
        .option("--limit <n>", "Most reports to list (default 100)", parseIntArg)
        .action(
            async (
                area: string,
                flags: { radius?: number; type?: string | boolean; limit?: number },
                command: Command
            ) => {
                const types = await pickCategories({ given: flags.type, subcommand: "alerts" });
                if (types === null) {
                    return;
                }

                await runOperation(command, "alerts", { area, radiusKm: flags.radius, types, limit: flags.limit });
            }
        );

    program
        .command("jams [area]")
        .description("Traffic jams around a place or box, or along a trip with --from and --to")
        .option("--from <place>", "Trip start (with --to)")
        .option("--to <place>", "Trip destination (with --from)")
        .option("--radius <km>", "Radius around a place (default 5)", parseNumberArg)
        .option("--min-level <n>", "Lowest Waze jam level 0-5 (default 0)", parseIntArg)
        .option("--corridor <metres>", "Trip corridor width (default 150)", parseIntArg)
        .action(
            async (
                area: string | undefined,
                flags: { from?: string; to?: string; radius?: number; minLevel?: number; corridor?: number },
                command: Command
            ) => {
                if (!area && !(flags.from && flags.to)) {
                    out.log.error("Give an area, or both --from and --to");
                    process.exitCode = 1;
                    return;
                }

                await runOperation(command, "jams", {
                    area,
                    from: flags.from,
                    to: flags.to,
                    radiusKm: flags.radius,
                    minLevel: flags.minLevel,
                    corridorM: flags.corridor,
                });
            }
        );

    program
        .command("near <place>")
        .description("Everything right around one place: reports and jams within a small radius")
        .option("--radius <km>", "Radius (default 2)", parseNumberArg)
        .action(async (place: string, flags: { radius?: number }, command: Command) => {
            await runOperation(command, "near", { place, radiusKm: flags.radius });
        });

    program
        .command("venues <query>")
        .description("Waze place search around a point (fuel, parking, shops); venue ids feed the venue command")
        .option("--near <place>", "Search around this place")
        .option("--limit <n>", "Most results (default 10)", parseIntArg)
        .action(async (query: string, flags: { near?: string; limit?: number }, command: Command) => {
            await runOperation(command, "venues", { query, near: flags.near, limit: flags.limit });
        });

    program
        .command("venue <id>")
        .description("One Waze venue: address, phone, services, opening hours")
        .action(async (id: string, _flags: unknown, command: Command) => {
            await runOperation(command, "venue", { id });
        });

    program
        .command("geocode <query>")
        .description('Place name → coordinates (Waze search, then OpenStreetMap); "lat,lon" → street address')
        .action(async (query: string, _flags: unknown, command: Command) => {
            await runOperation(command, "geocode", { query });
        });

    program
        .command("link <to>")
        .description("Official Waze deep links (waze.com/ul) for a destination; no browser tab needed")
        .option("--from <place>", "Also print a live-map directions link from here")
        .option("--no-navigate", "Show the place without starting navigation")
        .action(async (to: string, flags: { from?: string; navigate?: boolean }, command: Command) => {
            await runOperation(command, "link", { to, from: flags.from, navigate: flags.navigate });
        });

    program
        .command("open <to>")
        .description("Open the Waze deep link for a destination (the live map with directions when --from is given)")
        .option("--from <place>", "Start of the trip")
        .action(async (to: string, flags: { from?: string }, command: Command) => {
            try {
                const links = await buildLinks({ to, from: flags.from });
                const url = links.directions ?? links.navigate;
                openUrl(url);
                out.println(url);
            } catch (error) {
                logger.debug({ error, command: command.name() }, "waze open failed");
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
