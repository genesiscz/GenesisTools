#!/usr/bin/env bun
import { watchToolRun } from "@genesiscz/utils/cli/failures/watch";

// Kept so `tools jenkins-mcp` and MCP configs that launch it keep working. The code lives in src/jenkins.
watchToolRun({ tool: "jenkins-mcp" });
const { runEntry } = await import("../jenkins/lib/mcp/entry");

await runEntry(process.argv.slice(2));
