import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineAction, defineArea, type Fix, type FixDecision } from "@genesiscz/utils/genesis-tools/actions/define";
import { defaultBuildCommand } from "@genesiscz/utils/genesis-tools/app-builder";
import {
    APP_FACES,
    type AppFaceFlag,
    type AppPartId,
} from "@genesiscz/utils/genesis-tools/capability/generated/app-surface";
import { Need, type NeedSpec } from "@genesiscz/utils/genesis-tools/capability/needs";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { z } from "zod";

const FACE_FLAGS = Object.keys(APP_FACES) as [AppFaceFlag, ...AppFaceFlag[]];

/** `open` returns once Launch Services handed the flags over; a slower answer means it hangs. */
const OPEN_TIMEOUT_MS = 15_000;

export function windowFailureMessage(failure: { reason: string; fix?: Fix | null }): string {
    return failure.fix ? `${failure.reason}\n${failure.fix.command}` : failure.reason;
}

/** Some older hub builds lack the diff viewer the review window uses to display a proposal. */
export function reviewResourcesProblem(bundle: string): string | undefined {
    if (!existsSync(join(bundle, "Contents", "Resources", "diff-viewer", "index.html"))) {
        return `GenesisTools.app has no bundled diff viewer.\n${defaultBuildCommand("hub")}`;
    }

    return undefined;
}

function partOf(flag: AppFaceFlag): AppPartId | null {
    return APP_FACES[flag].part;
}

/** The needs of opening a face: macOS, the bundle, the part that ships the face, and a person who can see it. */
function openNeeds(flag: AppFaceFlag): NeedSpec[] {
    const part = partOf(flag);
    return [Need.platform.darwin, Need.app.installed, ...(part ? [Need.app.part(part)] : []), Need.person.display];
}

/** The argv of `open`: `-n` hands the flags to a running face too, `-g` keeps the caller in front. */
export function windowOpenArgv(params: { window: AppFaceFlag; args: readonly string[]; activate: boolean }): string[] {
    return [
        "/usr/bin/open",
        "-n",
        ...(params.activate ? [] : ["-g"]),
        genesisAppBundlePath(),
        "--args",
        params.window,
        ...params.args,
    ];
}

const openArgs = z.object({
    window: z.enum(FACE_FLAGS),
    args: z.array(z.string()).default([]),
    activate: z.boolean().default(true),
});

const fixPolicy = z.enum(["skip", "offer", "build"]);

/** The windows of GenesisTools.app: opening a face checks that the installed build ships it. */
export const windows = defineArea({
    area: "windows",
    summary: "Open a window (face) of GenesisTools.app",
    config: z.object({
        /** When the face's part is not built: skip, ask in the terminal, or build without asking. */
        fix: fixPolicy.default("offer"),
    }),
    actions: {
        open: defineAction({
            timeoutMs: 600_000,
            summary: "Open a GenesisTools.app window: --hub, --meetings, --recorder, --window and the other faces",
            args: openArgs,
            result: z.object({ window: z.enum(FACE_FLAGS), opened: z.literal(true) }),
            config: z.object({ fix: fixPolicy.optional() }),
            native: {
                needs: (args) => openNeeds(args.window),
                run: async (ctx) => {
                    if (ctx.args.window === "--review") {
                        const problem = reviewResourcesProblem(genesisAppBundlePath());
                        if (problem) {
                            throw new Error(problem);
                        }
                    }

                    logger.debug({ window: ctx.args.window, args: ctx.args.args }, "windows.open: opening a face");
                    const argv = windowOpenArgv(ctx.args);
                    const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: OPEN_TIMEOUT_MS });

                    if (proc.exitCode !== 0) {
                        throw new Error(
                            `open exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).trim()}`
                        );
                    }

                    return { window: ctx.args.window, opened: true as const };
                },
            },
            fix: (ctx): FixDecision => {
                const policy = ctx.config.fix ?? "offer";
                const part = ctx.failed.need.kind === "app.part" ? ctx.failed.need.part : null;

                if (policy === "build") {
                    return ctx.build(part);
                }

                return policy === "offer" ? ctx.offerBuild(part) : ctx.skip();
            },
            manual: (args) => `open -n ${genesisAppBundlePath()} --args ${[args.window, ...args.args].join(" ")}`,
        }),
    },
});

declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        windows: typeof windows;
    }
}
