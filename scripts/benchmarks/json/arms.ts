/** The ways of parsing that `parse-child.ts` runs; `parse-arms.ts` runs all of them. */
export const PARSE_ARMS = [
    "jsonParse",
    "decodeJsonParse",
    "safeJson",
    "commentJson",
    "bunJsonl",
    "simdjsonFullParse",
    "simdjsonPick",
] as const;
