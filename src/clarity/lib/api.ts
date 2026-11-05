import { ClarityClient } from "@app/clarity/lib/auth/client";
import type { ClarityAuth } from "@app/clarity/lib/auth/types";
import type { ClarityApi } from "@genesiscz/utils/clarity";

/** The Clarity API. Without `auth` it uses the saved session and renews it when its driver can. */
export function getClarityApi(options: { auth?: ClarityAuth } = {}): ClarityApi {
    return new ClarityClient(options.auth);
}
