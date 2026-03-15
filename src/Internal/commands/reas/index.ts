import type { Command } from "commander";
import pc from "picocolors";

interface ReasOptions {
    district?: string;
    type?: string;
    disposition?: string;
    periods?: string;
    price?: string;
    area?: string;
    rent?: string;
    monthlyCosts?: string;
    output?: string;
    refresh?: boolean;
}

async function runReasAnalysis(options: ReasOptions): Promise<void> {
    console.log(pc.yellow("Not implemented yet"));
    console.log(pc.dim("Options:"), options);
}

export function registerReasCommand(program: Command): void {
    program
        .command("reas")
        .description("Real estate investment analyzer (reas.cz + sreality + MF cenová mapa)")
        .option("--district <name>", "District name (e.g. 'Hradec Králové')")
        .option("--type <type>", "Property type: panel, brick, house")
        .option("--disposition <disp>", "Disposition (e.g. 3+1, 3+kk, 2+1)")
        .option("--periods <periods>", "Comma-separated periods (e.g. 2024,2025)")
        .option("--price <czk>", "Target property asking price in CZK")
        .option("--area <m2>", "Target property area in m²")
        .option("--rent <czk>", "Expected monthly rent in CZK")
        .option("--monthly-costs <czk>", "Monthly costs (fond oprav + utilities) in CZK")
        .option("-o, --output <path>", "Write report to file")
        .option("--refresh", "Force re-fetch (ignore cache)")
        .action(async (options: ReasOptions) => {
            await runReasAnalysis(options);
        });
}
