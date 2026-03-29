/**
 * Stub type declarations for on-demand packages.
 *
 * These packages are NOT installed by default — they're installed at runtime
 * via ensurePackage() when first needed. The stubs let TypeScript accept
 * dynamic import() expressions without having the packages in node_modules.
 *
 * When a package IS installed, its real types from node_modules/@types or
 * the package's own .d.ts files take precedence over these stubs.
 */

declare module "@huggingface/transformers";
declare module "@huggingface/inference";
declare module "@lancedb/lancedb";
declare module "@qdrant/js-client-rest";
