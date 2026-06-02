/**
 * Browser-side auth client (Better-Auth React). Used by the signup / signin forms and the
 * dashboard's session hook. Talks to the /api/auth/* handler mounted from `auth.server.ts`.
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
