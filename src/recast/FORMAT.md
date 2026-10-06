# Recast conversion package and evidence format

A conversion is an ordinary `.recast` directory. Its `manifest.json` stores the conversion; `sources/` contains immutable original bytes named `<sha256>.<extension>`. The manifest and source files are sufficient to reopen it. Disposable previews and temporary inference files are outside the package. External locations are optional hints and never identify evidence.

The portable implementation is [document.ts](lib/document.ts), [operations.ts](lib/operations.ts), [validation.ts](lib/validation.ts) and [render.ts](lib/render.ts). Their strict Zod schemas and cross-reference checks are the executable contract. `tools recast inspect --input PATH --verify-assets` validates the package without writing it.

## Versions and identifiers

The manifest has `format: "genesis-recast"`, `version: 2`, `id`, `title`, a nonnegative integer `revision`, and arrays `sources`, `anchors`, `readings`, `collections`, `records`, `corrections`, `contradictions` and `journal`. `renderings` and `reconciliations` default to empty when absent. Version 2 requires the contradictions array even when empty. Unknown properties and unsupported versions are rejected by the portable reader.

A version 1 manifest without contradiction state migrates to version 2 on read. Version 1 with contradiction state is rejected. Older version 1 readers reject version 2; writing the new review state with an old version number could silently discard it and is prohibited.

Identifiers match `[a-z][a-z0-9_]{0,63}`; `constructor`, `prototype` and `__proto__` are reserved. IDs are unique within each entity array. Stored creation times use ISO 8601 UTC. SHA-256 hashes use 64 lowercase hexadecimal characters.

## Originals, anchors and readings

A source contains `id`, original `name`, `mime`, `kind` (`image`, `pdf`, `text`, `audio`, `unsupported`), `contentHash`, `assetName`, `bytes`, `importedAt` and `pages`. Optional metadata includes `pageCount`, UTF-16 `textLength`, `durationMs`, `externalLocation`, a parser `error` and a `replaces` source ID. Unsupported sources still retain their original bytes.

An anchor contains `id`, `sourceId`, `sourceHash`, a `label` and a discriminated `region`:

| Kind | Stored coordinates | Meaning |
| --- | --- | --- |
| `rect` | zero-based `page`, normalized `x`, `y`, `width`, `height` | Bottom-left origin; positive rectangle entirely inside an image/PDF page. |
| `text` | UTF-16 `start`, exclusive `end`, exact `quote`, `prefix`, `suffix` | Offsets into the frozen source; surrounding context is optional and at most 160 UTF-16 units each. |
| `audio` | source-relative `startMs`, exclusive `endMs` | Positive interval within the known recording duration. |
| `whole` | no coordinates | Opaque original attachment; it does not establish an extracted interpretation. |

`sourceHash` must equal the referenced source hash. An optional anchor `fingerprint` stores the 256-bit average hash of a bounded 16×16 grayscale region preview. It is a replacement hint, not a source identity or semantic confidence score. Multiple matching regions remain ambiguous.

A reading contains `id`, `anchorId`, literal `text`, up to eight string `alternatives`, `method` (`manual`, `pdf-text`, `vision-ocr`, `transcript`), `engine` and `createdAt`. Corrections never overwrite readings. Provider timing is used only when it is valid; otherwise transcript readings cover the selected interval with an explicit review warning.

## Objects and review

Collections have `id`, `label`, `kind` (`table`, `checklist`, `calendar`) and ordered `fields`. Each field has an export-key `id`, display `label`, `type` (`text`, `number`, `boolean`, `date`, `datetime`, `timezone`) and `required`. Calendar collections retain `title`, `start`, `end` and `timezone`; checklists retain `title` and `done`. Tables may define typed fields.

Records have `id`, `collectionId`, `state` (`draft`, `accepted`, `archived`), `createdAt` and a `cells` map keyed by field ID. A cell has scalar `value` (string, finite number, boolean or null), `state` (`unknown`, `proposed`, `accepted`), `origin` (`source`, `inferred`, `user`), `anchorIds`, `readingIds`, scalar `alternatives` and `note`. Null stays explicitly unknown. Every attached reading belongs to an attached anchor. Up to sixteen anchors and sixteen readings may support one field.

Acceptance validates field types, required values and evidence separately. A schema-valid inferred value with missing evidence or only an opaque attachment cannot be accepted. Optional unknown fields may remain null. Unresolved replacement or competing-evidence reviews block affected records. Editing a field or its attachments returns it to review.

Corrections retain `before` and `after` cells, `recordId`, `fieldId`, human `reason` and `createdAt`. Source-local reuse recomputes the match against current frozen sources, kind/type/label, regions and complete readings. It creates an inferred proposal and retains the current field's evidence.

Reconciliations retain old/new source IDs and per-anchor `pending`, `kept` or `relinked` decisions. Contradictions retain a chosen collection/field, two to eight record/cell snapshots, contexts, reason, status and optional `keep-both`, `prefer` or `context` decision. Different strings alone never create a contradiction. Prefer-one archives the other entire records; context decisions require each context. Changes to compared evidence reopen the decision.

Each operation validates all targets and the expected revision before returning a new manifest, increments revision once and creates a journal entry. Bulk correction is one operation. The CLI applies an operation array to local manifests and returns only the final result if every operation succeeds; it does not write the input. Persistence is the caller's responsibility. Native Undo groups a submitted operation array and restores the previous manifest and source attachments as one transaction.

## Destinations and evidence map

CSV uses ordered field IDs as headers, optional `__recast_record_id`, quoted cells and CRLF. Formula-like strings receive a leading apostrophe for spreadsheet safety; the JSON object value and evidence map retain the original string. CSV re-import uses a saved rendering receipt and three-way comparison; it cannot reconstruct visual evidence.

JSON contains an ordered array of reviewed objects keyed by field ID. Markdown escapes source-derived markup and renders table/checklist/calendar structures. ICS resolves reviewed start/end/timezone to UTC, uses stable record UIDs, escapes text and folds UTF-8 lines at 75 octets. Ambiguous or nonexistent local times require a valid explicit offset. The same input and explicit render time produce the same destination text; generated receipt IDs are independent metadata.

The evidence map is JSON with `format: "genesis-recast-evidence"`, `version: 1`, document ID/revision, relevant collection schemas, competing-evidence decisions and records. Each record includes its collection ID. Each field exposes value/state/origin/note/alternatives and its source filename/hash, region and literal readings. A user-supplied timezone is visibly `origin: "user"`; it has no fabricated source extraction. The map identifies source bytes by hash but does not embed them or disclose external file locations.

Rendering receipts store output hash, format, collection, revision, creation time, field schema and exported row baseline. A preview is read-only. Native Save/Copy records the receipt through an explicit document operation. CLI callers use `record-rendering` before round-trip comparison.

## Invented ambiguity fixture

[ambiguous-journey.recast](fixtures/ambiguous-journey.recast/manifest.json) preserves an invented `08:?0` reading with `08:10` and `08:40` alternatives, a twenty-minute transfer note and a missing timezone. It is a manual ambiguity fixture, not an OCR accuracy result or transport information.

```sh
tools recast inspect --input src/recast/fixtures/ambiguous-journey.recast --verify-assets
tools recast render --input src/recast/fixtures/ambiguous-journey.recast --collection journeys --format ics
# Refused: departure and timezone require review.
tools recast apply --input src/recast/fixtures/ambiguous-journey.recast --revision 0 --operation src/recast/fixtures/review-journey.json
# Returns a reviewed manifest; save that result to a new file before rendering.
```

[review-journey.json](fixtures/review-journey.json) explicitly selects 08:40, supplies Europe/Prague and accepts the record. Existing tests verify the package hash, unchanged literal readings, CSV/ICS agreement, deterministic output and timezone provenance.

[screenshot-spec.recast](fixtures/screenshot-spec.recast/manifest.json) contains authored artwork of an invented account form, three selected image rectangles and manual literal readings of its field/state rules. It demonstrates a table specification with image evidence; it is not a screenshot of a real account or an OCR capability claim. The empty native window loads either package as an independent editable conversion.

The implementation bounds source/record/region/history sizes. See `RECAST_LIMITS` and the schemas for exact maxima. These limits bound local work; they do not establish OCR or transcription accuracy on arbitrary input.

Disposable thumbnail entries live in the shared storage cache for `recast/previews`, with a 64 MiB/128-entry/14-day policy. Only managed preview keys are evicted. An entry includes source hash, source kind, page, renderer version and PNG digest; cache contents do not replace the protected source snapshots. A reader can delete these previews and reconstruct the same conversion from the package.
