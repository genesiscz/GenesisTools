import { defineOpenAPIConnection } from "eve/connections";

const baseUrl = (process.env.YOUTUBE_API_BASE_URL ?? "http://127.0.0.1:9876").replace(/\/$/, "");

export default defineOpenAPIConnection({
  spec: `${baseUrl}/api/v1/openapi.json`,
  baseUrl,
  description: "Local GenesisTools YouTube server: channels, videos, transcripts, summaries, and Q&A.",
});
