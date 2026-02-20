/**
 * Azure DevOps CLI - Barrel re-export for backward compatibility.
 * Import from specific modules for new code.
 */
export * from "./config";
export * from "./task-files";
export * from "./url-parser";
export * from "./relations";
export * from "./change-detection";
export * from "./field-schema";
export * from "./templates";

// Re-export shared utilities for backward compatibility
export { htmlToMarkdown } from "@app/utils/markdown/html-to-md";
export { slugify } from "@app/utils/string";
export { levenshteinDistance, similarityScore } from "@app/utils/fuzzy-match";
export { formatBytes } from "@app/utils/format";
