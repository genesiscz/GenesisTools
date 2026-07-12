/**
 * What the injected side panel is currently attached to. Computed by the
 * content script from the URL: a `/watch` or `/shorts/<id>` page yields a
 * video target, a channel page (`/@handle`, `/channel/<id>`, `/c/<name>`)
 * yields a channel target whose handle may be null when it can't be resolved
 * from the URL alone.
 */
export type PanelTarget = { kind: "video"; videoId: string } | { kind: "channel"; handle: string | null };
