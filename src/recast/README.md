# Recast

Recast turns selected source material into reviewed tables, checklists, and calendar events. The native macOS window keeps each field beside the source region and literal reading that support it. Corrections retain the original evidence.

Open a new conversion with `tools recast`, or reopen a package with `tools recast open <file.recast>`. Import text, screenshots, or PDFs and choose **Extract rows** or **Read into field**. Optional AI mapping returns proposals for review. Short recordings support interval playback and reviewed transcription.

An empty conversion offers an invented ambiguous timetable and an authored screenshot specification. Examples load into independent editable conversions, preserve their packaged originals and keep every record as a draft. They do not establish OCR accuracy or verified travel information.

## Review and export

Use **Split** to keep the source beside objects, or select **Source**, **Objects** or **Destination**. Below 1,050 points, Split shows Objects; **Show evidence** switches to the source without losing the selected record. Destination lists required and unreviewed fields even when export is blocked. Each issue navigates to its field. A changed document invalidates its previous rendering.

The package, anchor and renderer contract is published in [FORMAT.md](FORMAT.md), with an [invented ambiguous journey](fixtures/ambiguous-journey.recast/manifest.json) and explicit review operations. The evidence map includes collection schemas so custom field IDs can be interpreted by another reader.

A `.recast` package contains a versioned manifest and independent source snapshots verified by SHA-256. Required unknown fields, unaccepted records, invalid dates, and unresolved source replacement decisions block export.

The window exports CSV, Markdown, JSON, and calendar ICS. Calendar events require explicit time zones; repeated or skipped local times require a valid offset. CSV output protects formula-like strings.

To edit a CSV outside Recast:

1. Save or copy a CSV with **Row IDs for re-import** enabled.
2. Edit the CSV, retaining its headers and row IDs.
3. Choose **Review CSV edits…** from the export receipt or File menu.
4. Compare exported, current, and incoming values; choose conflicts explicitly.
5. Apply selected edits, then review and accept the resulting drafts.

Unchanged CSV fields preserve newer local corrections. Missing rows propose archiving. New or repeated row IDs are rejected. Re-importing an applied edit adds no correction. Forgetting a receipt is undoable, but comparison requires that baseline.

`tools recast open ./conversion.recast --review-csv ./edited.csv` opens the same native comparison sheet directly. It stages the comparison and applies nothing until you choose changes and confirm them. The conversion must contain a matching CSV receipt with row IDs.

## Replacing a source

Import the replacement as another source. **Read regions for comparison** captures literal readings without creating duplicate records. Choose **Review replacement…**, select both snapshots, and start the review.

Both snapshots remain available. Affected records become drafts and cannot be exported while evidence is unresolved. Recast suggests regions, identifies ambiguous readings, and lets you choose another region or retain the original evidence. Applying a decision preserves prior readings and corrections; it does not accept the retained values.

Text matches can use recorded surrounding text to distinguish repeated readings. New image/PDF extractions include a bounded 16×16 region fingerprint, computed from one page preview. Nearby regions with sufficiently similar nonblank fingerprints may be suggested even when their literal readings differ. A fingerprint is a comparison hint, not proof that the meaning is unchanged. Multiple matches remain ambiguous and every relink still requires a user decision. Historical regions without fingerprints can be read again for comparison.

Selecting a field reveals its first evidence region. Evidence can open in a separate read-only window. The numeric region editor provides an alternative to dragging a rectangle or selecting text.

## Attaching evidence to an existing field

Select a field and choose **Manage evidence…**. Attach or remove saved regions and individual literal readings across sources without replacing the value. Selecting a reading attaches its region too; removing a region removes its reading links. Each field supports sixteen regions and sixteen readings. Source text, OCR alternatives, and original files remain in the document when a link is removed.

Use **Objects → Attach Selected Region…** to stage the current text selection, image/PDF rectangle, or audio interval. Text selections also stage an exact literal reading; other source types attach the region without running OCR or transcription. Dragging a saved source-region row onto a field opens the same review sheet. A link from another document or an old revision is refused.

Checkbox changes stay local until **Apply evidence changes**. The field value and its origin remain unchanged, while the field and record return to review. A correction records the old and new links, and one Undo restores the entire change. Removing all evidence from an inferred value does not relabel it as user-supplied: acceptance still requires evidence or an explicit manual correction.

The CLI uses `set-evidence` through `apply`, with `recordId`, `fieldId`, `anchorIds`, `readingIds`, and `reason`. Both arrays are the complete desired attachment sets, and every reading must belong to an attached region. Existing `attach-anchor` calls also invalidate field acceptance.

## Bulk corrections and unreadable originals

Select record checkboxes, or **Select all**, then choose **Correct selected…**. Pick one field, enter a replacement or Unknown, inspect the before/after values and source labels, and explain the batch. Preview pages contain up to 200 records. The operation changes exactly the selected records, preserves their separate evidence and literal readings, and returns them to review. One Undo restores the entire batch. Changes to compared fields also reopen their competing-evidence review.

The CLI operation is `bulk-correct`, with `collectionId`, `fieldId`, unique `recordIds`, scalar `value`, `note`, and `reason`. It validates every target before committing and creates one journal transaction.

An unreadable source remains in the package. **Attach original to field** attaches the entire opaque file without fabricating a reading. A manual value can retain that original for reference. An inferred value cannot be accepted using an unreadable or whole-source attachment as its only support.

## Competing evidence

Select a field and choose **Competing evidence…**. Choose two to eight records that you believe describe the same claim, and inspect each value, literal reading and original source region. Different strings alone do not create a contradiction.

Choose **Keep both readings**, **Prefer one record**, or **Apply in different contexts**, and write a reason. Prefer-one archives the other complete records while retaining their sources and values; the sheet states this before applying. Contextual decisions require an explanation for each record, included in the evidence report. Reopening a review can restore both records. Retained records remain drafts until accepted.

A pending comparison blocks acceptance and export for its competing records. Changing a compared value, note, origin or evidence reopens the comparison; changing another field does not. One Undo restores the decision and all affected record states. Saved comparisons appear in the sidebar.

The CLI supports `start-contradiction` and `resolve-contradiction` operations through `apply`. Package version 2 preserves the new review state. Version 1 packages migrate when read; older readers reject version 2, and reviews in a version 1 manifest are refused to prevent silent data loss.

## Reusing a local correction

Select a field with attached literal readings and choose **Suggest a source-local correction…**. Recast compares earlier human corrections with the current frozen source content, object kind, field label/type, regions and full readings. Every piece of the earlier evidence must still be represented. A similar string from an unrelated source does not transfer the correction.

Inspect the old value, corrected value, reason, sources and reading excerpts. **Use as proposal** applies the suggested value to the current field's evidence as an inferred draft. The source readings remain unchanged and the record still needs acceptance. This is a local example, not a trained recognizer.

The read-only CLI is `correction-examples --input <file> --record <id> --field <id>`. `reuse-correction` through `apply` recomputes the match against the current revision before applying. Up to 64 recent matches are shown within a 512 KiB preview budget; reading excerpts keep 500 complete characters, while matching uses the full stored text.

## Choosing input for AI mapping

**Structure with AI…** reads the current selection and opens a reading picker. **Map saved readings…** reuses readings already in the document, including transcripts. Select individual readings across sources, inspect their literal text and alternatives, and check the exact input preview before generating.

Choose a configured AI account, or enter a model reference. The account list is read-only. Up to 200 readings may be selected, with a 32,000-character limit on the complete serialized input including collection fields and source metadata. An oversized source can still be mapped in smaller selections. Unselected readings, original files, and external file locations are not sent.

Proposals may cite only selected readings and their recorded alternatives. A changed selection or destination invalidates the preview and cancels an active proposal transaction. Generated records remain drafts; quote matching establishes where the words came from, not whether the interpretation is correct.

## Audio sources

Import a recording of at most fifteen minutes, select its start and end in seconds, and use **Play selection** to listen. Playback stops at the selected endpoint. **Mute** changes only playback in that window. Selecting a field with audio evidence restores that interval.

Choose an enabled transcription account and model, then **Transcribe selection**. The account list reads configuration without binding credentials. Cloud providers receive only the selected interval; local providers may download model files before inference. Account availability does not establish that its credentials are usable.

Review the returned text while listening to the original. **Save readings** retains evidence without adding records, **Create rows** creates drafts, and **Read into field** attaches the transcript to the selected field. Provider timestamps become source intervals only when they are valid. Otherwise the reading covers the whole selected interval with an explicit warning. Corrections preserve the original transcript.

The source bytes are verified before clipping. Cancellation stops FFmpeg and propagates to the provider. The native window owns a direct transcription process and escalates termination after 500 ms if active local inference does not cooperate. The native command has a 620-second deadline; the shared transcription operation requests cancellation after 600 seconds.

## Saving and recovery

Recast saves the selected source region before OCR or transcription and autosaves manual corrections before a model call. If saving fails or takes longer than sixty seconds, interpretation does not start. A changed input is refused above the native provider process launch. Saved conversions autosave in place; untitled conversions use macOS crash-recovery contents.

After a forced quit, choose **File → Recover Autosaved Conversion…** and select a Recast package from macOS Autosave Information. Some autosaved packages have no extension. Recovery verifies the manifest and source snapshots, opens an independent untitled conversion and preserves the package you selected. Save the recovered conversion to choose its destination.

All Recast windows share two model/transcription job slots. Queued jobs can be cancelled and stop waiting after sixty seconds. Local image/PDF decoding remains serialized by the native source reader. Completed document operations remain when a later job is cancelled.

Image/PDF previews decode only the selected page. A disposable disk cache keys thumbnails by frozen source hash, kind, page and renderer version. It keeps at most 64 MiB and 128 entries, evicts the least recently used previews, expires entries after fourteen days and refuses entries larger than 32 MiB. Corrupt or missing entries regenerate from the package's original bytes. Cancellation is checked after decoding and before caching a completed preview. Originals never depend on the cache.

Cache writes and eviction use a nonblocking file lock across app instances. If another writer holds it, the window uses its decoded page without adding a cache entry; it does not wait or spin.

## Command-line interfaces

The native window and CLI share validated operations. These commands return JSON:

```sh
tools recast new --title 'Release checklist' --kind checklist
tools recast inspect --input ./release.recast --verify-assets
tools recast render --input ./release.recast --collection COLLECTION_ID --format csv
tools recast roundtrip --input ./release.recast --receipt RECEIPT_ID --csv ./edited.csv
tools recast reconcile --input ./release.recast --old SOURCE_ID --new SOURCE_ID --job REVIEW_ID
tools recast apply --input ./release.recast --revision 12 --operation ./operations.json
tools recast proposal-choices
tools recast proposal-context --input ./release.recast --collection COLLECTION_ID --readings READING_ONE,READING_TWO
tools recast propose --input ./release.recast --collection COLLECTION_ID --readings READING_ONE,READING_TWO --instruction 'Make a checklist' --model @account/ACCOUNT_ID
tools recast transcription-choices
tools recast transcribe --input ./release.recast --source SOURCE_ID --audio ./recording.wav --start-ms 0 --end-ms 12000 --model @account/ACCOUNT_ID
tools recast capture-transcript --input ./release.recast --review ./transcript.json --collection COLLECTION_ID --mode rows
```

`inspect`, `roundtrip`, and `reconcile` do not write to the package. `apply` returns the next manifest; its caller owns persistence. It rejects stale revisions and applies the batch atomically. `render --output <file>` creates an export without replacing an existing file.

A rendering response contains a `receipt`. Record it with a `record-rendering` operation before CLI re-import. `apply-roundtrip` takes the CSV, receipt ID, and selected preview change IDs. Replacement uses `start-reconciliation` and `resolve-reconciliation`. See `lib/operations.ts` for the complete schemas.

## Current limits and verification boundaries

A document supports 128 sources, 2,000 records, 5,000 active evidence links, and 20,000 historical anchors/readings. Each source is limited to 100 MiB; distinct source bytes total at most 512 MiB and the manifest at most 32 MiB. Up to 32 export receipts and 128 source reviews are retained.

Implementation remains in progress. Core re-import and replacement have automated and CLI fixture coverage. Native persistence, text extraction, PDF reading, and correction have been exercised. Audio has real muted interval-playback coverage and an isolated Whisper Tiny transcription through the production CLI with network disabled during inference. Its transcript was captured, saved, reopened, accepted, and exported through CLI fixtures with original source hashes intact.

Live structured generation has produced three draft checklist rows from the saved transcript through a configured subscription account, with selected-reading checks and original assets verified. Multiple evidence attachment and competing-evidence decisions have production-CLI coverage and native apply/undo/package-reopening tests. A real local Apple Vision test recognizes the selected invented timetable's 08:40 and excludes the unselected 11:20, with valid region bounds on macOS 26.3.1. This capability check does not establish accuracy for blurred images or all supported OS versions.

Interactive native checks have exercised numeric text/image-region selection, actual OCR into a field, acceptance, highlighted image reveal, detached text/image evidence and the 860×650 minimum window. Native CSV review applied a user-supplied draft and one Undo restored its accepted baseline, with saved packages retaining original evidence. Evidence, competing-evidence, correction-reuse, source-replacement, AI-input and export sheets have open/cancel checks. Signed transcript controls played a muted 1–3-second interval, stopped at 3 seconds, ran cached Whisper Tiny through an isolated production-CLI fixture and saved reviewed readings with original audio preserved. The transcript review explicitly disclosed missing word timing. Live cancellation during inference and an uninterrupted keyboard-only conversion remain unclaimed. Cloud transcription, OCR across supported OS versions and difficult inputs, broader audio accuracy, and complex-document performance remain unmeasured. One successful synthetic recording does not establish transcription accuracy for other recordings or languages.
