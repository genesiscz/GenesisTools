import { defineOpenAPIConnection } from "eve/connections";
import { eveEnv } from "../lib/env";
import { parseServiceKeys } from "../lib/service-key-auth";

const baseUrl = eveEnv.getYoutubeApiBaseUrl();

// When the youtube server is protected with YOUTUBE_SERVICE_KEY (comma-separated,
// one key per user), present the first key as `Authorization: Bearer <key>` on
// operation calls. The spec fetch (`/api/v1/openapi.json`) is an open meta route,
// so it needs no auth. Unset → no auth field, behavior unchanged.
const youtubeKey = parseServiceKeys(eveEnv.getYoutubeServiceKey())[0];

export default defineOpenAPIConnection({
  spec: `${baseUrl}/api/v1/openapi.json`,
  baseUrl,
  description: "Local GenesisTools YouTube server: channels, videos, transcripts, summaries, and Q&A.",
  ...(youtubeKey ? { auth: { getToken: async () => ({ token: youtubeKey }) } } : {}),
});
