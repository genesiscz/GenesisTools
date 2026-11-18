import { isInteractive } from "@genesiscz/utils/cli";
import { type AppBuilder, defaultBuildCommand, registerAppBuilder } from "@genesiscz/utils/genesis-tools/app-builder";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";

/** The tool fills the shared seam; importing the actions package never loads the macos tool. */
export function registerCliAppBuilder(): void {
    const build: AppBuilder["build"] = async (part, progress) => {
        refuseHostEffectInTest("app build", "Inject an AppBuilder in tests.");
        const { buildApp } = await import("@app/macos/lib/permissions/app");
        await buildApp({ ...progress, ...(part ? { parts: { add: [part] } } : {}) });
    };
    registerAppBuilder({
        build,
        buildCommand: defaultBuildCommand,
        offerBuild: async (part) => {
            refuseHostEffectInTest("app build offer", "Inject an AppBuilder in tests.");

            if (!isInteractive()) {
                return false;
            }

            const p = await import("@genesiscz/utils/prompts/p");
            if (
                !(await p.confirm({
                    message: `Build GenesisTools.app${part ? ` with ${part}` : ""}?`,
                    initialValue: false,
                }))
            ) {
                return false;
            }

            await build(part);
            return true;
        },
    });
}
