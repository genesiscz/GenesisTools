import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { METRICS_REGISTRARS } from "./registrars";

const program = new Command();
program
    .name("metrics")
    .description(
        "Record a number with its context (project, metric, value, dims), and ask about it: filter, group, sort and bucket by time, down to the single event"
    );

await runTool(program, { tool: "metrics", registrars: METRICS_REGISTRARS });
