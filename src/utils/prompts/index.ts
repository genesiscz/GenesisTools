/**
 * Shared prompt utilities for GenesisTools CLI.
 *
 * This module provides utilities for both @inquirer/prompts and @clack/prompts.
 *
 * Usage:
 *   // Shared utilities (colors, formatting)
 *   import { pc, styled, formatList } from "@app/utils/prompts";
 *
 *   // Clack-specific (preferred for new tools)
 *   import { withCancel, handleCancel, searchMultiselect } from "@app/utils/prompts/clack";
 *
 *   // Inquirer-specific (for existing tools)
 *   import { isUserCancellation, runPrompt } from "@app/utils/prompts/inquirer";
 */

// Shared utilities
export * from "./colors";
