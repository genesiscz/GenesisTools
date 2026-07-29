import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Where the sherpa-onnx diarization weights have always lived. It predates the
 * artifact store and sits under the transcribe tool rather than the ai one;
 * the store registers it as a legacy root so those ~31 MB stay visible to
 * `list`/`prune` without a relocation nobody asked for.
 *
 * Kept in its own near-leaf module (node + the env facade only) so both the
 * store and the sherpa runtime can name it without an import cycle. Resolved
 * through GENESIS_TOOLS_HOME rather than a bare homedir(): this was the one
 * `.genesis-tools` path in the AI tree the sandbox could not contain, and
 * `ArtifactStore.prune()` deletes under it — a sandboxed run must never point
 * that at the user's real weights.
 */
export const DIARIZE_MODEL_DIR = join(env.tools.getHome(), ".genesis-tools", "transcribe", "models", "diarization");
