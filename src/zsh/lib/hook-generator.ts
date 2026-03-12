import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage.ts";
import { getFeature } from "../features/index.ts";
import type { ZshConfig } from "../features/types.ts";

const storage = new Storage("zsh");

export function generateHookScript(config: ZshConfig): string {
    const lines: string[] = [
        "# GenesisTools shell hook — auto-generated, do not edit",
        `# Enabled features: ${config.enabled.join(", ") || "(none)"}`,
        "",
    ];

    for (const name of config.enabled) {
        const feature = getFeature(name);

        if (!feature) {
            continue;
        }

        lines.push(`# --- feature: ${feature.name} ---`);

        if (feature.shellOnly === "zsh") {
            lines.push('if [ -n "$ZSH_VERSION" ]; then');
            lines.push(feature.shellScript);
            lines.push("fi");
        } else if (feature.shellOnly === "bash") {
            lines.push('if [ -n "$BASH_VERSION" ]; then');
            lines.push(feature.shellScript);
            lines.push("fi");
        } else {
            lines.push(feature.shellScript);
        }

        lines.push("");
    }

    return lines.join("\n");
}

export async function writeHookFile(config: ZshConfig): Promise<string> {
    await storage.ensureDirs();
    const hookPath = join(storage.getBaseDir(), "hook.sh");
    const content = generateHookScript(config);
    await Bun.write(hookPath, content);
    return hookPath;
}
