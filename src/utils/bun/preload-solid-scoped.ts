/**
 * Scoped replacement for `@opentui/solid/preload`.
 *
 * The upstream preload registers a Bun plugin whose `onLoad` filter matches
 * EVERY .ts/.tsx file in the project (`/\.(js|ts)x(?:[?#].*)?$/`) and runs
 * babel-preset-solid on it — turning React/Ink JSX into Solid runtime calls
 * and breaking hooks ("Invalid hook call", "Rendered more hooks than during
 * the previous render"). Bun does not currently allow `onLoad` callbacks to
 * return null/undefined to fall through to the default loader (oven-sh/bun#5303,
 * PR #24279 closed unmerged), so the only way to scope a transform is via the
 * `filter` regex itself.
 *
 * This preload mirrors the upstream Solid transform but tightens `filter` to
 * files under `src/doctor/` (the only place Solid is used). Everything else
 * goes through Bun's native react-jsx loader untouched.
 *
 * Babel packages are loaded lazily via createRequire(PROJECT_ROOT) so preloads
 * keep working when Bun is invoked from another cwd (tools launcher, IDE hooks).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BunPlugin, plugin as registerBunPlugin } from "bun";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromRoot = createRequire(join(PROJECT_ROOT, "package.json"));

const SOLID_PATH_FILTER = /[/\\]src[/\\]doctor[/\\][^?#]*\.[jt]sx(?:[?#].*)?$/;

function stripQueryAndHash(path: string): string {
    const q = path.indexOf("?");
    const h = path.indexOf("#");
    const cuts = [q, h].filter((i) => i >= 0).sort((a, b) => a - b);
    return cuts.length === 0 ? path : path.slice(0, cuts[0]);
}

interface BabelModules {
    transformAsync: typeof import("@babel/core")["transformAsync"];
    babelPresetTypescript: unknown;
    babelPresetSolid: unknown;
}

let babelModules: BabelModules | undefined;

function loadBabelModules(): BabelModules {
    if (babelModules) {
        return babelModules;
    }

    const { transformAsync } = requireFromRoot("@babel/core") as typeof import("@babel/core");
    babelModules = {
        transformAsync,
        babelPresetTypescript: requireFromRoot("@babel/preset-typescript"),
        babelPresetSolid: requireFromRoot("babel-preset-solid"),
    };

    return babelModules;
}

const scopedSolidPlugin: BunPlugin = {
    name: "bun-plugin-solid-scoped",
    setup(build) {
        build.onLoad({ filter: SOLID_PATH_FILTER }, async (args) => {
            const { transformAsync, babelPresetTypescript, babelPresetSolid } = loadBabelModules();
            const path = stripQueryAndHash(args.path);
            const code = await Bun.file(path).text();

            const result = await transformAsync(code, {
                filename: path,
                configFile: false,
                babelrc: false,
                presets: [
                    [babelPresetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
                    [babelPresetTypescript],
                ],
            });

            return {
                contents: result?.code ?? code,
                loader: "js",
            };
        });
    },
};

registerBunPlugin(scopedSolidPlugin);
