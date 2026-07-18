/**
 * Shared prompt utilities for GenesisTools CLI.
 *
 * Usage:
 *   // Shared utilities (colors, formatting)
 *   import { pc, styled, formatList } from "@genesiscz/utils/prompts";
 *
 *   // Clack-specific (preferred for new tools)
 *   import { withCancel, handleCancel, searchMultiselect } from "@genesiscz/utils/prompts/clack";
 *
 *   // Backend-switching API (supports inquirer backend for TTY tools)
 *   import * as p from "@genesiscz/utils/prompts/p";
 *   import { inquirerBackend } from "@genesiscz/utils/prompts/p/inquirer-backend";
 */

// Shared utilities
export * from "./colors";
