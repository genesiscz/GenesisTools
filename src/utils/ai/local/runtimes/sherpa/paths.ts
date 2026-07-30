import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the sherpa-onnx diarization weights have always lived. It predates the
 * artifact store and sits under the transcribe tool rather than the ai one;
 * the store registers it as a legacy root so those ~31 MB stay visible to
 * `list`/`prune` without a relocation nobody asked for.
 *
 * Kept in its own leaf module (no imports beyond node) so both the store and
 * the sherpa runtime can name it without an import cycle.
 */
export const DIARIZE_MODEL_DIR = join(homedir(), ".genesis-tools", "transcribe", "models", "diarization");
