import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverTools } from "@app/tools/lib/discovery";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const program = new Command()
    .name("update")
    .description("Update GenesisTools to the latest version")
    .action(async () => {
        const genesisPath = process.env.GENESIS_TOOLS_PATH || resolve(import.meta.dir, "../..");
        const srcDir = join(genesisPath, "src");

        console.log(pc.cyan("\n  Updating GenesisTools...\n"));

        // 1. Git pull
        console.log(pc.dim("  Pulling latest changes..."));
        const pull = Bun.spawnSync(["git", "pull"], {
            cwd: genesisPath,
            stdio: ["inherit", "inherit", "inherit"],
        });
        if (pull.exitCode !== 0) {
            console.error(pc.red("  Failed to git pull"));
            process.exit(1);
        }

        // 2. Clean install dependencies (rm node_modules to avoid stale nested deps)
        console.log(pc.dim("\n  Installing dependencies (clean)..."));
        const nodeModulesPath = join(genesisPath, "node_modules");
        Bun.spawnSync(["rm", "-rf", nodeModulesPath], { stdio: ["inherit", "inherit", "inherit"] });
        const install = Bun.spawnSync(["bun", "install"], {
            cwd: genesisPath,
            stdio: ["inherit", "inherit", "inherit"],
        });
        if (install.exitCode !== 0) {
            console.error(pc.red("  Failed to bun install"));
            process.exit(1);
        }

        // 3. Claude Code plugin management
        const inClaudeCode = Boolean(process.env.CLAUDE_CODE_SESSION_ID);
        const runClaudeUpdates = await p.confirm({
            message: inClaudeCode
                ? "Run Claude plugin update and marketplace update?"
                : "Run Claude marketplace update, add, and plugin install?",
            initialValue: true,
        });
        if (p.isCancel(runClaudeUpdates)) {
            p.cancel("Cancelled");
            process.exit(0);
        }
        if (runClaudeUpdates) {
            if (inClaudeCode) {
                console.log(pc.dim("\n  Adding marketplace (if needed)..."));
                Bun.spawnSync(["claude", "plugin", "marketplace", "add", "https://github.com/genesiscz/GenesisTools"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });

                console.log(pc.dim("\n  Installing plugin (if needed)..."));
                const pluginInstall = Bun.spawnSync(["claude", "plugin", "install", "genesis-tools@genesis-tools"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });
                if (pluginInstall.exitCode !== 0) {
                    console.log(pc.yellow("  Plugin install had issues (may already be installed)"));
                }

                console.log(pc.dim("\n  Updating Claude Code plugin..."));
                const pluginUpdate = Bun.spawnSync(["claude", "plugin", "update", "genesis-tools@genesis-tools"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });
                if (pluginUpdate.exitCode !== 0) {
                    console.log(pc.yellow("  Plugin update had issues"));
                }
            } else {
                console.log(pc.dim("\n  Updating Claude Code marketplace..."));
                Bun.spawnSync(["claude", "plugin", "marketplace", "update"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });

                console.log(pc.dim("\n  Adding marketplace..."));
                Bun.spawnSync(["claude", "plugin", "marketplace", "add", "https://github.com/genesiscz/GenesisTools"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });

                console.log(pc.dim("\n  Installing plugin..."));
                const pluginInstall = Bun.spawnSync(["claude", "plugin", "install", "genesis-tools@genesis-tools"], {
                    stdio: ["inherit", "inherit", "inherit"],
                });
                if (pluginInstall.exitCode !== 0) {
                    console.log(pc.yellow("  Plugin install had issues"));
                }
            }
        }

        // 4. Show latest changelog entry
        const changelogPath = join(genesisPath, "CHANGELOG.md");
        if (existsSync(changelogPath)) {
            const changelog = readFileSync(changelogPath, "utf-8");
            const latestEntry = extractLatestEntry(changelog);
            if (latestEntry) {
                console.log(pc.cyan("\n  Latest changes:"));
                console.log(pc.dim(`  ${latestEntry.split("\n").join("\n  ")}`));
            }
        }

        // 5. "Did you know" message
        const tools = discoverTools(srcDir);
        const skills = discoverSkills(join(genesisPath, "plugins/genesis-tools/skills"));

        console.log(pc.green("\n  GenesisTools updated successfully!\n"));
        console.log(pc.cyan("  Did you know we have a lot of Claude tools available? Install with:\n"));
        console.log("    claude plugin marketplace add https://github.com/genesiscz/GenesisTools");
        console.log("    claude plugin install genesis-tools@genesis-tools\n");

        console.log(pc.cyan("  Available commands:"));
        for (const tool of tools.slice(0, 20)) {
            console.log(`    ${pc.bold(tool.name)} - ${pc.dim(tool.description)}`);
        }
        if (tools.length > 20) {
            console.log(pc.dim(`    ... and ${tools.length - 20} more. Run 'tools' to see all.`));
        }

        console.log(pc.cyan("\n  Available skills:"));
        for (const skill of skills) {
            console.log(`    ${pc.bold(`genesis-tools:${skill.name}`)} - ${pc.dim(skill.description)}`);
        }

        console.log("");
    });

function extractLatestEntry(changelog: string): string | null {
    const lines = changelog.split("\n");
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("## ") && start === -1) {
            start = i;
        } else if (lines[i].startsWith("## ") && start !== -1) {
            end = i;
            break;
        }
    }
    if (start === -1) {
        return null;
    }
    return lines.slice(start, end).join("\n").trim();
}

function discoverSkills(skillsDir: string): Array<{ name: string; description: string }> {
    if (!existsSync(skillsDir)) {
        return [];
    }
    const skills: Array<{ name: string; description: string }> = [];
    for (const entry of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, entry, "SKILL.md");
        if (existsSync(skillFile)) {
            const content = readFileSync(skillFile, "utf-8");
            const descMatch = content.match(/^description:\s*(.+)$/m);
            skills.push({
                name: entry,
                description: descMatch?.[1]?.trim() ?? entry,
            });
        }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
}

program.parse();
