/**
 * The on-device model stack, one layer per folder:
 *
 *   descriptors/  what exists — the catalogue, task-tagged, runtime-tagged
 *   artifacts/    how weights are fetched, cached and pruned
 *   runtimes/     how inference actually executes
 *   adapters/     how a runtime plugs into the provider-plugin layer
 *
 * Adding a local model is one descriptor entry; adding a backend is one folder
 * under runtimes/.
 */

export type { CachedArtifact, PruneReport, ResolvedArtifact } from "./artifacts";
export { ArtifactStore, HfSource, UrlSource } from "./artifacts";
export type { ArtifactRef, LocalModelDescriptor, LocalRuntimeId } from "./descriptors";
export {
    byTask,
    byTaskAndProvider,
    embeddingProviderTypes,
    embedModelsForType,
    findDescriptor,
    LOCAL_MODELS,
    maxEmbedChars,
    taskPrefix,
} from "./descriptors";
export { detectDevice, type OnnxDevice, resolveDevice } from "./device";
export { CoreMLRuntime, type LocalRuntime, TransformersJsRuntime } from "./runtimes";
