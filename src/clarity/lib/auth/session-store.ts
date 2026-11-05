import { authStorageSessionStore } from "@app/clarity/lib/auth/auth-storage-session-store";
import type { ClaritySessionStore } from "@app/clarity/lib/auth/types";

/** Where the Clarity session lives. A downstream copy of this tool can point it at its own secret store. */
export const claritySessionStore: ClaritySessionStore = authStorageSessionStore;
