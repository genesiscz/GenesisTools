import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { parse } from "@iarna/toml";

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enable installed native support by default; explicit false keeps the caller's configuration. */
export function computerUseLaunchOverrides(options: {
    home: string;
    resourcesPath?: string;
    enabled?: boolean;
}): string[] {
    if (options.enabled === false) {
        return [];
    }
    const resources = options.resourcesPath ?? "/Applications/ChatGPT.app/Contents/Resources";
    const installed = [
        join(resources, "cua_node/bin/node"),
        join(resources, "cua_node/bin/node_repl"),
        join(options.home, "computer-use/Codex Computer Use.app"),
    ].every(existsSync);
    return options.enabled === true || installed ? computerUseOverrides(options) : [];
}

/** Per-process overrides only. Desktop owns its generated node_repl and plugin manifests. */
export function computerUseOverrides(options: { home: string; resourcesPath?: string }): string[] {
    const resources = options.resourcesPath ?? "/Applications/ChatGPT.app/Contents/Resources";
    const node = join(resources, "cua_node/bin/node");
    const repl = join(resources, "cua_node/bin/node_repl");
    const modules = join(resources, "cua_node/lib/node_modules");
    const helper = join(options.home, "computer-use/Codex Computer Use.app");
    if (![node, repl, helper].every(existsSync)) {
        throw new Error(
            "Official Computer Use must be installed in the shared Codex home and ChatGPT.app before using --computer-use"
        );
    }

    const configPath = join(options.home, "config.toml");
    const config = existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) : {};
    const servers = record(config.mcp_servers) ? config.mcp_servers : {};
    const existing = record(servers.node_repl) ? servers.node_repl : {};
    const existingEnv = record(existing.env) ? existing.env : {};
    let services: unknown = {};
    if (typeof existingEnv.NODE_REPL_TRUSTED_SERVICES === "string") {
        try {
            services = SafeJSON.parse(existingEnv.NODE_REPL_TRUSTED_SERVICES, { strict: true });
        } catch (error) {
            logger.debug({ configPath, error }, "Existing Node REPL trusted-service registration is not JSON");
            throw new Error(`Invalid existing Node REPL trusted-service registration in ${configPath}`);
        }
    }

    if (!record(services) || Object.values(services).some((value) => typeof value !== "string")) {
        throw new Error(`Invalid existing Node REPL trusted-service registration in ${configPath}`);
    }

    const environment = {
        CODEX_HOME: options.home,
        CODEX_CLI_PATH: join(resources, "codex"),
        NODE_REPL_NODE_PATH: node,
        NODE_REPL_NODE_MODULE_DIRS: modules,
        NODE_REPL_TRUSTED_CODE_PATHS: `${options.home}:${modules}`,
        NODE_REPL_TRUSTED_SERVICES: SafeJSON.stringify({ ...services, sky: "@oai/sky/service" }, { strict: true }),
        SKY_CUA_SERVICE_PATH: helper,
        NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE:
            "Use the official @oai/sky runtime to inspect and operate Mac applications.",
    };
    return [
        "features.computer_use=true",
        `mcp_servers.node_repl.command=${SafeJSON.stringify(repl)}`,
        "mcp_servers.node_repl.args=[]",
        "mcp_servers.node_repl.enabled=true",
        "mcp_servers.node_repl.startup_timeout_sec=120",
        ...Object.entries(environment).map(
            ([key, value]) => `mcp_servers.node_repl.env.${key}=${SafeJSON.stringify(value)}`
        ),
    ];
}
