import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { bisectCommand } from "./commands/bisect";
import { diffCommand } from "./commands/diff";
import { unpackCommand } from "./commands/unpack";
import { versionsCommand } from "./commands/versions";

const program = new Command();

program.name("claude-code").description("Unpack, diff, and bisect npm-published Claude Code CLI bundles");

program
    .command("versions")
    .description("List published @anthropic-ai/claude-code versions with publish dates")
    .option("--from <version>", "Range start (inclusive)")
    .option("--to <version>", "Range end (inclusive)")
    .option("--json", "Emit JSON", false)
    .option("--force", "Bypass the 1h packument cache", false)
    .action(versionsCommand);

program
    .command("unpack")
    .description("Fetch + extract (+ beautify) one version's cli.js bundle")
    .argument("<version>", "Exact published version, e.g. 2.1.196")
    .option("--platform <platform>", "Platform package suffix (default: host, e.g. darwin-arm64)")
    .option("--beautified", "Also produce beautified.js and print its path", false)
    .option("--normalized", "Also produce normalized.js and print its path", false)
    .option("--force", "Re-download even if cached", false)
    .action(unpackCommand);

program
    .command("diff")
    .description("Chunk-based, identifier-normalized diff between two versions")
    .argument("<v1>")
    .argument("<v2>")
    .option("--pattern <regex...>", "Only show changed chunks matching ALL patterns")
    .option("--mode <mode>", "chunks | normalized | raw", "chunks")
    .option("--context <n>", "Unified diff context lines", "3")
    .option("--max-chunks <n>", "Cap rendered chunk pairs without --pattern", "20")
    .option("--platform <platform>", "Platform package suffix")
    .option("-o, --output <file>", "Write diff to file instead of stdout")
    .action(diffCommand);

program
    .command("bisect")
    .description("Walk published versions in a range; report where a code pattern transition happens")
    .argument("<from>")
    .argument("<to>")
    .requiredOption("--pattern <regex...>", "First = anchor; rest must co-occur in its window (probe mode)")
    .option("--mode <mode>", "probe | chunks", "probe")
    .option("--window-before <n>", "Probe window chars before anchor", "800")
    .option("--window-after <n>", "Probe window chars after anchor", "200")
    .option("--platform <platform>", "Platform package suffix")
    .option("--json", "Emit JSON", false)
    .action(bisectCommand);

await runTool(program, { tool: "claude-code" });
