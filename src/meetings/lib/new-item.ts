import type { MeetingItem } from "@genesiscz/utils/meetings/record";

/** `Omit` applied to each member of a union, so each kind keeps its own fields. */
export type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An item before it has an id and a time. */
export type NewItem = OmitEach<MeetingItem, "id" | "suggestedAt">;
