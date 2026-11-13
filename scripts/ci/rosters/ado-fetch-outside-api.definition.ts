import { callTo, defineRoster } from "./define";

/** C50: Azure DevOps calls went around `Api.send`, so they missed its auth, retry and error mapping. */
export default defineRoster({
    name: "roster-ado-fetch-outside-api",
    candidate: "C50",
    message:
        "Call Azure DevOps through `Api.send` in src/azure-devops/api.ts. It adds the PAT, the retry on 429 and 5xx, " +
        "and the typed error; a bare `fetch` misses all three (the review found four such paths).",
    matcher: callTo(["fetch"]),
    onlyIn: /^src\/azure-devops\//,
    allowedIn: /^src\/azure-devops\/api\.ts$/,
});
