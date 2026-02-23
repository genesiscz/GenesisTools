// Quick verification test for imports

import { formatTokens } from "./dist/core/formatting.js";
import { Storage as StorageSubpath } from "./dist/core/storage/index.js";
import { createLogger, debounce, formatDuration, Storage } from "./dist/index.js";

console.log("Testing imports...");

// Test Storage
const storage = new Storage("test-tool");
console.log("✓ Storage imported:", storage.getBaseDir());

// Test formatting
console.log("✓ formatDuration:", formatDuration(125000));
console.log("✓ formatTokens:", formatTokens(15000));

// Test debounce
const debouncedFn = debounce(() => console.log("debounced"), 100);
console.log("✓ debounce works:", typeof debouncedFn);

// Test logger
const logger = createLogger({ level: "info" });
console.log("✓ createLogger works:", logger.level);

// Test subpath import
const storageSubpath = new StorageSubpath("test-subpath");
console.log("✓ Subpath import works:", storageSubpath.getCacheDir());

console.log("\nAll imports verified successfully!");
