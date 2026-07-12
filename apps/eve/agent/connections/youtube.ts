import { defineOpenAPIConnection } from "eve/connections";
import { parseServiceKeys } from "../lib/service-key-auth";

const baseUrl = (process.env.YOUTUBE_API_BASE_URL ?? "http://127.0.0.1:9876").replace(/\/$/, "");

// When the youtube server is protected with YOUTUBE_SERVICE_KEY (comma-separated,
// one key per user), present the first key as `Authorization: Bearer <key>` on
// operation calls. The spec fetch (`/api/v1/openapi.json`) is an open meta route,
// so it needs no auth. Unset → no auth field, behavior unchanged.
const youtubeKey = parseServiceKeys(process.env.YOUTUBE_SERVICE_KEY)[0];

export default defineOpenAPIConnection({
  spec: `${baseUrl}/api/v1/openapi.json`,
  baseUrl,
  description: "Local GenesisTools YouTube server: channels, videos, transcripts, summaries, and Q&A.",
  ...(youtubeKey ? { auth: { getToken: async () => ({ token: youtubeKey }) } } : {}),
});
