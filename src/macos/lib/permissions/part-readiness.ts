import { spawnSync } from "node:child_process";
import { appStatus, buildApp } from "@app/macos/lib/permissions/app";
import { partForFace } from "@app/macos/lib/permissions/parts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("part-readiness");

export interface FaceBuildProgress {
    onStep?: (line: string) => void;
    /** Live progress of the long `swift build` step (`BuildAppOptions.onProgress`). */
    onProgress?: (line: string) => void;
}

/** What opening a face needs from the machine; tests pass fakes, so no app is built or started. */
export interface FaceDeps {
    /** The installed app: whether it is built, whether its Swift sources changed since, and the parts it links. */
    status(): { built: boolean; stale: boolean; parts: readonly string[] };
    /** Builds the app with the installed parts plus this one. */
    build(part: string, progress: FaceBuildProgress): Promise<void>;
    open(args: string[]): { status: number | null; stderr: string };
}

/** How long `open` may take to hand a face to Launch Services; a stalled one is killed and reported, not waited on. */
const OPEN_TIMEOUT_MS = 15_000;

export const LIVE_FACE_DEPS: FaceDeps = {
    status: () => appStatus(),
    build: async (part, progress) => {
        await buildApp({ ...progress, parts: { add: [part] } });
    },
    open: (args) => {
        const result = spawnSync("open", args, { encoding: "utf8", timeout: OPEN_TIMEOUT_MS, killSignal: "SIGKILL" });
        return { status: result.status, stderr: result.stderr || result.error?.message || "" };
    },
};

export interface FaceReadyPolicy {
    /** `allow` builds the app with the face's part when it is not ready; `refuse` returns the refusal instead. */
    build: "allow" | "refuse";
    /** `accept` opens a stale build as it is; the default `rebuild` treats it as not ready. */
    stale?: "rebuild" | "accept";
    /** A face's own reason the installed app cannot serve it (the hub's review resources), or undefined. */
    check?: () => string | undefined;
}

export type FaceReadiness =
    | { ready: true; built: boolean; reason?: string }
    | { ready: false; reason: string; command: string; sentence: string };

function faceSubject(face: string): { part: string; command: string } {
    const part = partForFace(face);

    if (!part) {
        throw new Error(`${face} is not a face that a part of GenesisTools.app serves`);
    }

    return { part, command: toolCommand("macos", "permissions", "build", "--add-part", part) };
}

function notReadyReason(part: string, policy: FaceReadyPolicy, deps: FaceDeps): string | undefined {
    const status = deps.status();

    if (!status.built) {
        return "GenesisTools.app is not built";
    }

    if (status.stale && policy.stale !== "accept") {
        return "GenesisTools.app is older than its Swift sources";
    }

    if (!status.parts.includes(part)) {
        return `GenesisTools.app was built without the ${part} part`;
    }

    return policy.check?.();
}

/**
 * Whether the installed app can serve this face as it is, without building. A synchronous caller (the REPL's movie
 * calls) refuses with the sentence; `ensureFaceReady` builds instead when its policy allows.
 */
export function faceReadiness(face: string, policy: FaceReadyPolicy, deps: FaceDeps = LIVE_FACE_DEPS): FaceReadiness {
    const { part, command } = faceSubject(face);
    const reason = notReadyReason(part, policy, deps);

    if (!reason) {
        return { ready: true, built: false };
    }

    log.debug({ face, part, reason }, "part readiness: not ready");
    return { ready: false, reason, command, sentence: `${reason}, so nothing was started. Build it: ${command}` };
}

/**
 * Makes sure the installed app can serve this face: the part comes from the face table (`partForFace`), a build that
 * is missing, stale or without the part is rebuilt with it when the policy allows, else the refusal says the command.
 */
export async function ensureFaceReady(
    face: string,
    policy: FaceReadyPolicy & FaceBuildProgress,
    deps: FaceDeps = LIVE_FACE_DEPS
): Promise<FaceReadiness> {
    const readiness = faceReadiness(face, policy, deps);

    if (readiness.ready || policy.build === "refuse") {
        return readiness;
    }

    const { part } = faceSubject(face);
    policy.onStep?.(`${readiness.reason}: building it with the ${part} part (about a minute on a cold build)`);
    log.info({ face, part, reason: readiness.reason }, "part readiness: building the app with the part");
    await deps.build(part, { onStep: policy.onStep, onProgress: policy.onProgress });
    return { ready: true, built: true, reason: readiness.reason };
}

/** Starts a face through Launch Services with these `open` arguments; throws with `open`'s message when it fails. */
export function openFace(args: string[], deps: FaceDeps = LIVE_FACE_DEPS): void {
    const result = deps.open(args);

    if (result.status !== 0) {
        throw new Error(`open failed (${result.status}): ${result.stderr.trim()}`);
    }
}
