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
 */

import { transformAsync } from "@babel/core";
// @ts-expect-error - no published types
import babelPresetTypescript from "@babel/preset-typescript";
// @ts-expect-error - no published types
import babelPresetSolid from "babel-preset-solid";
import { type BunPlugin, plugin as registerBunPlugin } from "bun";

const SOLID_PATH_FILTER = /[/\\]src[/\\]doctor[/\\][^?#]*\.[jt]sx(?:[?#].*)?$/;

function stripQueryAndHash(path: string): string {
    const q = path.indexOf("?");
    const h = path.indexOf("#");
    const cuts = [q, h].filter((i) => i >= 0).sort((a, b) => a - b);
    return cuts.length === 0 ? path : path.slice(0, cuts[0]);
}

const scopedSolidPlugin: BunPlugin = {
    name: "bun-plugin-solid-scoped",
    setup(build) {
        build.onLoad({ filter: SOLID_PATH_FILTER }, async (args) => {
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
