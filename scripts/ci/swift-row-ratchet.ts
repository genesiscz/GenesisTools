/**
 * The views that still break the dense-row gates of swift-lint-rules.ts, counted 2026-10-30 when the gates were
 * added. One key per view: `<file>#<struct>`. A ratchet: no view joins a list, and a view leaves it as soon as it
 * is converted (a value row under `.liveRow(selected:)`, a `static let` formatter, an `==` that compares every
 * stored value). `lint-rules.test.ts` fails when a listed view no longer trips its gate, so a list cannot go stale.
 *
 * The lists were taken from `checkSwiftSource(file, text, { ratchets: false })` over every Swift file of
 * src/macos; the proposals behind the gates are in `.claude/plans/2026-10-29-SwiftLintRuleProposals/`.
 *
 * All four lists were emptied on 2026-11-01: every listed view was converted, or carries the `// lint-rules-ignore:`
 * its rule offers (a short fixed list, a property that follows a compared value). A new view that breaks a gate is
 * fixed in its own change, not listed here.
 */

/** `swift-row-observes-store`: rows a `ForEach` makes that still hold an observed store. */
export const SWIFT_ROW_OBSERVES_RATCHET: ReadonlySet<string> = new Set<string>([]);

/** `swift-row-control-at-rest`: rows a `ForEach` makes that still carry a control at rest (no `.liveRow`). */
export const SWIFT_ROW_CONTROL_RATCHET: ReadonlySet<string> = new Set<string>([]);

/** `swift-formatter-in-view`: views that still make a formatter or a regex in a body or a computed property. */
export const SWIFT_FORMATTER_IN_VIEW_RATCHET: ReadonlySet<string> = new Set<string>([]);

/** `swift-equatable-eq-skips-value`: `==` bodies that skip a stored value, not yet reviewed (a proxy such as `revision`, or a stale view). */
export const SWIFT_EQUATABLE_SKIPS_RATCHET: ReadonlySet<string> = new Set<string>([]);
