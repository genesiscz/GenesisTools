import { fileSessionStore } from "@app/clarity/lib/auth/file-session-store";
import type { ClaritySessionStore } from "@app/clarity/lib/auth/types";

/** Where the Clarity session lives. A downstream copy of this tool can point it at a secret store. */
export const claritySessionStore: ClaritySessionStore = fileSessionStore;
