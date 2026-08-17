import { stat } from "node:fs/promises";
import { join } from "node:path";
import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { isExpired, loadClaudeTokens } from "../lib/claude-tokens.ts";
import { type Journal, journalHealth, readJournal } from "../lib/journal.ts";
import { loadRegistry, loadToolCache } from "../lib/registry.ts";
import { cacheDir, LIB_DIR, pathExists, storeDepsMissing, storeRoot } from "../lib/store.ts";

interface Finding {
    level: "ok" | "warn" | "err";
    what: string;
    fix?: string;
}

/**
 * Diagnose the store. READ-ONLY by the diagnostics rule: reports and prints
 * fix commands, never applies them — including cache fills, which is why the
 * registry loads with `persist: false`. (`create`/`run` self-heal the tsconfig
 * and node_modules; doctor only says whether they would.)
 */
export function registerDoctor(program: Command): void {
    program
        .command("doctor")
        .description("Verify the script store: alias target, deps, journal, credentials. Read-only.")
        .option("--json", "Machine-readable output")
        .action(async (opts: { json?: boolean }) => {
            const root = storeRoot();
            const findings: Finding[] = [];

            if (!(await pathExists(root))) {
                findings.push({
                    level: "warn",
                    what: `store ${root} does not exist yet`,
                    fix: suggestCommand("tools scripts", {
                        replaceCommand: ["create", "<name>", "--import", "'<server>.*'"],
                    }),
                });
            } else {
                const tsconfigPath = join(root, "tsconfig.json");
                let mapped: string | undefined;

                try {
                    const parsed = SafeJSON.parse(await Bun.file(tsconfigPath).text()) as {
                        compilerOptions?: { paths?: Record<string, string[]> };
                    };
                    mapped = parsed.compilerOptions?.paths?.["@gt/scripts/*"]?.[0]?.replace(/\/\*$/, "");
                } catch (error) {
                    logger.debug({ tsconfigPath, error }, "doctor: tsconfig unreadable");
                }

                if (!mapped) {
                    findings.push({
                        level: "err",
                        what: `${tsconfigPath} missing or lacks the @gt/scripts/* mapping — persisted scripts cannot import the kit`,
                        fix: `${suggestCommand("tools scripts", { replaceCommand: ["run", "<any-script>"] })} (rewrites it), or any \`create\``,
                    });
                } else if (mapped !== LIB_DIR) {
                    const targetAlive = await pathExists(join(mapped, "kit.ts"));
                    findings.push({
                        level: targetAlive ? "warn" : "err",
                        what: `store tsconfig maps @gt/scripts to ${mapped}${targetAlive ? " (another checkout)" : " (dead path)"}, this checkout is ${LIB_DIR}`,
                        fix: `${suggestCommand("tools scripts", { replaceCommand: ["run", "<any-script>"] })} — the next run rewrites the mapping to this checkout`,
                    });
                } else {
                    findings.push({ level: "ok", what: `@gt/scripts alias → ${mapped}` });
                }

                if (await storeDepsMissing(root)) {
                    findings.push({
                        level: "warn",
                        what: "store node_modules missing (commander/picocolors unresolvable for direct `bun <script>` runs)",
                        fix: `bun install in ${root} (also runs automatically on '${suggestCommand("tools scripts", { replaceCommand: ["run"] })}')`,
                    });
                } else {
                    findings.push({ level: "ok", what: "store dependencies installed" });
                }

                if (await pathExists(join(root, ".git"))) {
                    const status = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"]);
                    const dirty = status.stdout.toString().trim();
                    findings.push({
                        level: "ok",
                        what: `store is a git repo${dirty ? ` (${dirty.split("\n").length} uncommitted change(s), swept by the next mutating verb)` : " (clean)"}`,
                    });
                } else {
                    findings.push({
                        level: "warn",
                        what: "store is not a git repo yet — scripts are unversioned",
                        fix: `any \`${suggestCommand("tools scripts", { replaceCommand: ["create"] })}\` or \`run\` initialises it`,
                    });
                }
            }

            // journalHealth first: readJournal on a corrupt file writes the
            // rescue backup, which a read-only diagnostic must not do.
            const health = await journalHealth();
            let journal: Journal = { version: 1, scripts: [] };

            if (health === "corrupt") {
                findings.push({
                    level: "err",
                    what: "persisted/_journal.json exists but cannot be parsed — scripts are invisible to list/run",
                    fix: "any mutating verb backs it up to _journal.corrupt-<stamp>.json and starts fresh; or repair the JSON by hand",
                });
            } else {
                journal = await readJournal();
            }

            const registryCache = join(cacheDir(root), "registry.json");

            if (await pathExists(registryCache)) {
                const mode = (await stat(registryCache)).mode & 0o777;

                if ((mode & 0o077) !== 0) {
                    findings.push({
                        level: "warn",
                        what: `cache/registry.json is mode ${mode.toString(8)} and carries connection env/headers (API keys)`,
                        fix: `${suggestCommand("tools scripts", { replaceCommand: ["servers", "--refresh"] })} (rewrites it 0600; any non-doctor load also repairs it)`,
                    });
                }
            }

            const registry = await loadRegistry({ persist: false });
            const known = new Set(registry.servers.map((s) => s.name));

            for (const entry of journal.scripts) {
                if (!(await pathExists(entry.file))) {
                    findings.push({
                        level: "err",
                        what: `journal entry '${entry.name}' points at missing ${entry.file}`,
                        fix: `${suggestCommand("tools scripts", { replaceCommand: ["rm", entry.name] })} (moves nothing, drops the stale entry)`,
                    });
                }

                const missingServers = entry.servers.filter((s) => !known.has(s));

                if (missingServers.length > 0) {
                    findings.push({
                        level: "warn",
                        what: `'${entry.name}' binds server(s) no provider lists any more: ${missingServers.join(", ")}`,
                        fix: `${suggestCommand("tools scripts", { replaceCommand: ["servers", "--refresh"] })}, or re-enable via tools mcp-manager`,
                    });
                }

                if (entry.gateDir && !(await pathExists(entry.gateDir))) {
                    findings.push({
                        level: "warn",
                        what: `'${entry.name}' is gated to ${entry.gateDir}, which no longer exists (hidden from every list)`,
                        fix: suggestCommand("tools scripts", { replaceCommand: ["tag", entry.name, "--ungate"] }),
                    });
                }
            }

            const toolCache = await loadToolCache();
            for (const cacheEntry of Object.values(toolCache)) {
                if (cacheEntry.error) {
                    findings.push({
                        level: "warn",
                        what: `cached probe failure for ${cacheEntry.server}: ${cacheEntry.error.slice(0, 120)}`,
                        fix: suggestCommand("tools scripts", {
                            replaceCommand: ["tools", `'${cacheEntry.server}.*'`, "--refresh"],
                        }),
                    });
                }
            }

            const tokens = await loadClaudeTokens();
            const expired = tokens.filter(isExpired);

            findings.push({
                level: expired.length > 0 ? "warn" : "ok",
                what: `Claude Code holds ${tokens.length} MCP OAuth token(s)${expired.length > 0 ? `; expired: ${expired.map((t) => t.serverName).join(", ")}` : ""}`,
                ...(expired.length > 0 ? { fix: "re-authorise in Claude Code with /mcp" } : {}),
            });

            if (opts.json) {
                out.result({ findings, scripts: journal.scripts.length, servers: registry.servers.length });
                return;
            }

            for (const f of findings) {
                ui[f.level](f.what);

                if (f.fix) {
                    ui.dim(`    fix: ${f.fix}`);
                }
            }

            const bad = findings.filter((f) => f.level !== "ok").length;
            ui.raw("");
            ui.raw(`${findings.length} check(s), ${bad} finding(s)`);
        });
}
