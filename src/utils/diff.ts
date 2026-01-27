// Re-export from @genesis-tools/utils package
// This shim maintains backwards compatibility with @app/utils/diff imports

export {
    DiffUtil,
    showDiff,
    detectConflicts,
    type DiffLogger,
    type DiffColorizer,
    type DiffOptions,
} from "@genesis-tools/utils/core/diff";
