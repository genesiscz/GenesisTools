/**
 * Shared prompt utilities for GenesisTools CLI.
 *
 * Usage:
 *   // Shared utilities (colors, formatting)
 *   import { pc, styled, formatList } from "@app/utils/prompts";
 *
 *   // Clack-specific (preferred for new tools)
 *   import { withCancel, handleCancel, searchMultiselect } from "@app/utils/prompts/clack";
 *
 *   // Backend-switching API (supports inquirer backend for TTY tools)
 *   import * as p from "@app/utils/prompts/p";
 *   import { inquirerBackend } from "@app/utils/prompts/p/inquirer-backend";
 */

// Shared utilities
export * from "./colors";
