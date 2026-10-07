#!/usr/bin/env bun
// Kept so `tools jenkins-mcp` and MCP configs that launch it keep working. The code lives in src/jenkins.
const { runEntry } = await import("../jenkins/lib/mcp/entry");

await runEntry(process.argv.slice(2));
