import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type FlockState, flockState } from "@genesiscz/utils/fs/flock";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { CAMERA_SIDECAR } from "@genesiscz/utils/recording-editor/camera";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * Who records the camera. `--camera` (and `movies.record({ camera: true })`) only writes `settings.camera.requested`
 * into recording.json; the camera movie is written by the menu bar recorder (`GenesisTools --recorder`,
 * Recorder/Capture/CameraBubble.swift), which watches the live recordings and records the camera for the one that
 * asks. Without that face running, the movie came back with no camera and nothing said so (review 2026-11-05).
 */

/** The lock the menu bar recorder holds for its whole life (Recorder/RecorderFace.swift `recorderInstance`). */
export function recorderFaceLockPath(): string {
    return genesisToolsDir("hub", "recorder.lock");
}

/** Whether the menu bar recorder runs; it is the only writer of `camera.mov`. */
export function recorderFaceState(): FlockState {
    return flockState(recorderFaceLockPath());
}

/** Why a recording that asks for the camera must not start, or undefined when it may (the face runs, or no answer). */
export function cameraRefusal(face: FlockState): string | undefined {
    if (face !== "free") {
        return undefined;
    }

    return `The camera needs the menu bar recorder of GenesisTools.app, which records it into camera.mov, and it is not running, so the movie would have no camera. Start it with ${toolCommand("recorder library --no-focus")} (it stays in the menu bar), then start the recording again, or record without the camera.`;
}

/** How long the end check waits for the menu bar recorder to finish the camera movie after the screen stopped. */
export const CAMERA_FINISH_WAIT_MS = 10_000;

/**
 * The warning for a recording that asked for the camera and got none, or undefined once `camera.json` is there (the
 * face writes it when the camera movie is finished and holds frames).
 */
export async function missingCameraWarning({
    folder,
    timeoutMs = CAMERA_FINISH_WAIT_MS,
}: {
    folder: string;
    timeoutMs?: number;
}): Promise<string | undefined> {
    if (await waitForPath(join(folder, CAMERA_SIDECAR), { timeoutMs })) {
        return undefined;
    }

    return `The camera was asked for, but no camera movie came: ${CAMERA_SIDECAR} is missing ${Math.round(timeoutMs / 1000)} s after the recording ended. The menu bar recorder stopped, or GenesisTools has no Camera access (System Settings → Privacy & Security → Camera).`;
}
