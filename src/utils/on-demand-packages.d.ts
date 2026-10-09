/**
 * Fallback type stubs for on-demand packages.
 *
 * These packages are NOT installed in the repo. ensurePackage() installs them
 * into the shared package store (src/utils/package-store.ts) when first
 * needed. The stubs let TypeScript accept importStorePackage() calls without
 * the packages in node_modules. package-store.ts references this file, so every
 * project that compiles a store import (the dashboards too) sees the stubs.
 *
 * ⚠️ WARNING: These bare ambient declarations permanently override real package
 * types. Even if the package is installed and ships its own .d.ts files, this
 * stub will shadow them, making all imports resolve as `any`. This is an
 * intentional trade-off to keep the project compilable without these
 * optional dependencies installed.
 */

declare module "@huggingface/transformers";
declare module "@huggingface/inference";
declare module "@lancedb/lancedb";
declare module "@qdrant/js-client-rest";
declare module "onnxruntime-node";
