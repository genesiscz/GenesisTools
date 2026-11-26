export const PUBLISH_KIND_IDS = ["md", "artifact"] as const;
export type PublishKindId = (typeof PUBLISH_KIND_IDS)[number];
