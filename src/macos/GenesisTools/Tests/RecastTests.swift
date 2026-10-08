import AppKit
import Combine
import CoreText
import CryptoKit
import Darwin
import GenesisKit
import PDFKit
import XCTest
@testable import GenesisTools

final class RecastTests: XCTestCase {
    private func file() throws -> RecastFile {
        try JSONDecoder().decode(RecastFile.self, from: Data(#"""
        {"format":"genesis-recast","version":1,"id":"fixture","title":"Conversion fixture","revision":0,
        "sources":[],"anchors":[],"readings":[],"collections":[{"id":"table","label":"Table","kind":"table",
        "fields":[{"id":"name","label":"Name","type":"text","required":true}]}],"records":[],"corrections":[],"journal":[]}
        """#.utf8))
    }

    private func source(_ bytes: Data) -> RecastSource {
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return RecastSource(id: "source_fixture", name: "Source.txt", contentHash: hash, assetName: hash + ".txt",
            mime: "text/plain", kind: "text", bytes: bytes.count, importedAt: "2026-01-01T12:00:00Z",
            pages: [], textLength: String(data: bytes, encoding: .utf8)?.utf16.count)
    }

    func testPackageRoundTripRetainsSourceBytesAndRejectsTampering() throws {
        let original = Data("A source with 😀 and 42".utf8)
        var document = try file()
        let source = source(original)
        document.sources = [source]
        let state = RecastState(file: document, assets: [source.assetName: original])
        let wrapper = try RecastPackage.encode(state)
        let reopened = try RecastPackage.decode(wrapper)
        XCTAssertEqual(reopened.assets[source.assetName], original)
        XCTAssertEqual(reopened.file.sources.first?.contentHash, source.contentHash)

        let bad = FileWrapper(directoryWithFileWrappers: [
            "manifest.json": try XCTUnwrap(wrapper.fileWrappers?["manifest.json"]),
            "sources": FileWrapper(directoryWithFileWrappers: [
                source.assetName: FileWrapper(regularFileWithContents: Data("A source with 😀 and 43".utf8))
            ])
        ])
        XCTAssertThrowsError(try RecastPackage.decode(bad))
        document.sources[0].assetName = "../outside.txt"
        let unsafe = FileWrapper(directoryWithFileWrappers: [
            "manifest.json": FileWrapper(regularFileWithContents: try JSONEncoder().encode(document)),
            "sources": FileWrapper(directoryWithFileWrappers: [:])
        ])
        XCTAssertThrowsError(try RecastPackage.decode(unsafe))
    }

    func testPackageRejectsFabricatedTextEvidenceAndMetadataForEachSource() throws {
        let bytes = Data("A 😀 source and 42".utf8)
        let original = source(bytes)
        var document = try file()
        document.sources = [original]
        document.anchors = [RecastAnchor(id: "anchor", sourceId: original.id, sourceHash: original.contentHash,
            label: "Exact evidence", region: RecastRegion(kind: "text", start: 2, end: 4, quote: "😀", prefix: "A ", suffix: " source"))]
        func decode(_ file: RecastFile) throws -> RecastState {
            try RecastPackage.decode(RecastPackage.encode(RecastState(file: file, assets: [original.assetName: bytes])))
        }
        XCTAssertNoThrow(try decode(document))
        var changed = document
        changed.anchors[0].region.quote = "XX"
        XCTAssertThrowsError(try decode(changed))
        changed = document; changed.anchors[0].region.prefix = "B "
        XCTAssertThrowsError(try decode(changed))
        changed = document; changed.anchors[0].region.suffix = " other"
        XCTAssertThrowsError(try decode(changed))
        changed = document; changed.sources[0].textLength = bytes.count
        XCTAssertThrowsError(try decode(changed))
        changed = document; changed.anchors[0].region.start = -1
        XCTAssertThrowsError(try decode(changed))
        changed = document; changed.anchors[0].region.end = 1000
        XCTAssertThrowsError(try decode(changed))
        changed = document
        var duplicate = original; duplicate.id = "duplicate"; duplicate.textLength = 1
        changed.sources.append(duplicate)
        XCTAssertThrowsError(try decode(changed), "Metadata must be checked even when bytes share an asset")
    }

    func testDroppedFileTimeoutCancelsProgressAndIgnoresLateCallback() async throws {
        let progress = Progress(totalUnitCount: 1)
        var reply: (@Sendable (URL?, Error?) -> Void)?
        do {
            _ = try await recastDroppedURL(timeoutSeconds: 0.01) { completion in reply = completion; return progress }
            XCTFail("An unresponsive provider must time out")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("did not finish loading in time"))
        }
        XCTAssertTrue(progress.isCancelled)
        reply?(URL(fileURLWithPath: "/fixture/late.txt"), nil)
    }

    @MainActor
    func testDroppedFileCancellationResumesWaitAndCancelsProgress() async throws {
        let started = expectation(description: "Item provider started")
        let progress = Progress(totalUnitCount: 1)
        let task = Task {
            try await recastDroppedURL { _ in started.fulfill(); return progress }
        }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        do { _ = try await task.value; XCTFail("A cancelled drop must finish") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(progress.isCancelled)
        let expected = URL(fileURLWithPath: "/fixture/source.txt")
        let loaded = try await recastDroppedURL { completion in
            completion(expected, nil)
            return Progress(totalUnitCount: 1)
        }
        XCTAssertEqual(loaded, expected)
    }

    func testDocumentRoutingIgnoresOnlyExplicitLaunchInputs() {
        let executable = URL(fileURLWithPath: "/fixture/tools")
        let source = URL(fileURLWithPath: "/fixture/source.txt")
        let document = URL(fileURLWithPath: "/fixture/conversion.recast")
        let args = ["--recast", "--tools", executable.path, "--source", source.path, "--open", document.path]
        XCTAssertTrue(AppDocumentController.isLaunchInput(executable, arguments: args))
        XCTAssertTrue(AppDocumentController.isLaunchInput(source, arguments: args))
        XCTAssertFalse(AppDocumentController.isLaunchInput(document, arguments: args))
        XCTAssertFalse(AppDocumentController.isLaunchInput(source, arguments: []))
        XCTAssertFalse(AppDocumentController.isLaunchInput(source, arguments: ["--source"]))
    }

    func testScalarRoundTripDistinguishesUnknownBooleanAndNumber() throws {
        let values: [RecastJSON] = [.null, .bool(false), .number(0), .number(1234.5), .string("false"), .string("😀")]
        let data = try JSONEncoder().encode(values)
        XCTAssertEqual(try JSONDecoder().decode([RecastJSON].self, from: data), values)
        XCTAssertEqual(RecastJSON.number(1234.5).display, "1234.5")
        XCTAssertEqual(RecastJSON.bool(false).display, "false")
    }

    func testDisplayedPDFRegionMapsToPageCoordinatesForEveryRotation() {
        let bounds = CGRect(x: -20, y: 30, width: 200, height: 100)
        let region = NativeSourceRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4)
        let ninety = NativeSourceReader.pdfPageRect(region, bounds: bounds, rotation: 90)
        XCTAssertEqual(ninety.minX, 60, accuracy: 0.000001)
        XCTAssertEqual(ninety.minY, 40, accuracy: 0.000001)
        XCTAssertEqual(ninety.width, 80, accuracy: 0.000001)
        XCTAssertEqual(ninety.height, 30, accuracy: 0.000001)
        for rotation in [0, 90, 180, 270, -90, 450] {
            let pageRect = NativeSourceReader.pdfPageRect(region, bounds: bounds, rotation: rotation)
            let display = NativeSourceReader.pdfDisplayRect(pageRect, bounds: bounds, rotation: rotation)
            XCTAssertEqual(display.x, region.x, accuracy: 0.000001)
            XCTAssertEqual(display.y, region.y, accuracy: 0.000001)
            XCTAssertEqual(display.width, region.width, accuracy: 0.000001)
            XCTAssertEqual(display.height, region.height, accuracy: 0.000001)
        }
    }

    func testReaderFindsRealRotatedPDFTextAndProducesOrientedPreview() async throws {
        let bytes = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: bytes))
        var box = CGRect(x: 0, y: 0, width: 400, height: 240)
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &box, nil))
        context.beginPDFPage(nil)
        let font = CTFontCreateWithName("Helvetica" as CFString, 26, nil)
        let string = NSAttributedString(string: "Fixture 42", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font
        ])
        context.textPosition = CGPoint(x: 40, y: 140)
        CTLineDraw(CTLineCreateWithAttributedString(string), context)
        context.endPDFPage(); context.closePDF()
        let pdf = try XCTUnwrap(PDFDocument(data: bytes as Data))
        let page = try XCTUnwrap(pdf.page(at: 0))
        page.rotation = 90
        let data = try XCTUnwrap(pdf.dataRepresentation())
        let displayRect = NativeSourceReader.pdfDisplayRect(CGRect(x: 35, y: 130, width: 200, height: 45), bounds: box, rotation: 90)
        let extraction = try await NativeSourceReader.shared.extract(data: data, kind: "pdf", page: 0, region: displayRect)
        XCTAssertEqual(extraction.method, "pdf-text")
        XCTAssertTrue(extraction.blocks.map(\.text).joined(separator: " ").contains("Fixture 42"))
        let preview = try await NativeSourceReader.shared.preview(data: data, kind: "pdf", page: 0)
        let image = try XCTUnwrap(NSBitmapImageRep(data: preview))
        XCTAssertLessThan(image.pixelsWide, image.pixelsHigh)
        for block in extraction.blocks { XCTAssertTrue(block.bounds?.isValid == true) }
    }

    func testPackageRetainsExportBaselinesAndPendingReconciliations() throws {
        var document = try file()
        let value = Data("Original evidence".utf8)
        let original = source(value)
        var replacement = original
        replacement.id = "replacement"
        document.sources = [original, replacement]
        document.anchors = [RecastAnchor(id: "old_anchor", sourceId: original.id,
            sourceHash: original.contentHash, label: "Evidence", region: RecastRegion(kind: "text",
                start: 0, end: 8, quote: "Original", prefix: "", suffix: " evidence"))]
        document.records = [RecastRecord(id: "record", collectionId: "table", state: "draft",
            cells: ["name": RecastCell(value: .string("Edited"), state: "proposed", anchorIds: ["old_anchor"])],
            createdAt: "2026-01-01T12:00:00Z")]
        document.renderings = [RecastRenderingReceipt(id: "rendering", documentId: document.id, revision: 0,
            collectionId: "table", format: "csv", createdAt: "2026-01-01T12:00:00Z", contentHash: original.contentHash,
            includeRecordIds: true, fields: document.collections[0].fields,
            rows: [RecastRenderingReceipt.Row(id: "record", values: ["name": .string("Original")])])]
        document.reconciliations = [RecastSourceReconciliation(id: "review", oldSourceId: original.id, newSourceId: replacement.id,
            createdAt: "2026-01-01T12:00:00Z", items: [.init(oldAnchorId: "old_anchor", status: "pending")])]
        let roundTrip = try RecastPackage.decode(RecastPackage.encode(RecastState(file: document, assets: [original.assetName: value])))
        XCTAssertEqual(roundTrip.file.renderings?.first?.rows.first?.values["name"], .string("Original"))
        XCTAssertEqual(roundTrip.file.reconciliations?.first?.items.first?.status, "pending")
        XCTAssertEqual(roundTrip.file.records.first?.cells["name"]?.value, .string("Edited"))
    }

    @MainActor
    func testFieldSelectionRevealsItsSourceAndClearsEvidenceForManualFields() throws {
        var document = try file()
        let data = Data("Source evidence".utf8)
        let original = source(data)
        document.sources = [original]
        document.anchors = [RecastAnchor(id: "anchor", sourceId: original.id, sourceHash: original.contentHash,
            label: "Source", region: RecastRegion(kind: "text", start: 0, end: 6, quote: "Source", prefix: "", suffix: " evidence"))]
        document.records = [
            RecastRecord(id: "linked", collectionId: "table", state: "draft", cells: [
                "name": RecastCell(value: .string("Value"), state: "proposed", anchorIds: ["anchor"])
            ], createdAt: "2026-01-01T12:00:00Z"),
            RecastRecord(id: "manual", collectionId: "table", state: "draft", cells: [
                "name": RecastCell(value: .string("Manual"), state: "proposed")
            ], createdAt: "2026-01-01T12:00:00Z"),
        ]
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(RecastState(file: document, assets: [original.assetName: data]))
        model.selectField(recordId: "linked", fieldId: "name")
        XCTAssertEqual(model.selectedAnchor, "anchor")
        XCTAssertEqual(model.selectedSource, original.id)
        model.selectField(recordId: "manual", fieldId: "name")
        XCTAssertEqual(model.selectedAnchor, "")
        XCTAssertNil(model.selectedRegion)
    }

    @MainActor
    func testAudioIntervalPlaybackStopsAtTheSelectedMediaTime() async throws {
        guard ProcessInfo.processInfo.environment["RUN_AUDIO_DEVICE"] == "1" else {
            throw XCTSkip("Explicit local audio-device check; playback is muted.")
        }
        let audio = NativeAudioPlayback()
        audio.volume = 0
        defer { audio.clear() }
        var data = Data()
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: "RIFF".utf8); number(UInt32(64036))
        data.append(contentsOf: "WAVEfmt ".utf8); number(UInt32(16))
        number(UInt16(1)); number(UInt16(1)); number(UInt32(16000))
        number(UInt32(32000)); number(UInt16(2)); number(UInt16(16))
        data.append(contentsOf: "data".utf8); number(UInt32(64000))
        data.append(Data(repeating: 0, count: 64000))
        audio.load(data: data, fileExtension: "wav", identity: "audio-fixture", duration: 2)
        let ready = expectation(description: "Audio prepared")
        let loading = audio.$isLoading.first(where: { !$0 }).sink { _ in ready.fulfill() }
        defer { loading.cancel() }
        await fulfillment(of: [ready], timeout: 5)
        XCTAssertNil(audio.error)
        XCTAssertTrue(audio.canPlay)
        XCTAssertTrue(audio.select(start: 0, end: 2.0004))
        XCTAssertEqual(audio.selectionEnd, 2)
        XCTAssertFalse(audio.select(start: 0, end: 2.001))
        XCTAssertFalse(audio.select(start: 2.0001, end: 2.0004))
        XCTAssertTrue(audio.select(start: 0.4, end: 0.8))
        XCTAssertFalse(audio.select(start: 1.8, end: 1.7))
        XCTAssertEqual(audio.selectionStart, 0.4)
        XCTAssertTrue(audio.select(start: 0.4, end: 0.8))
        let ended = expectation(description: "Selected interval ended")
        let stopped = audio.$isPlaying.drop(while: { !$0 }).first(where: { !$0 }).sink { _ in ended.fulfill() }
        defer { stopped.cancel() }
        audio.playSelection()
        await fulfillment(of: [ended], timeout: 5)
        XCTAssertNil(audio.error)
        XCTAssertFalse(audio.isPlaying)
        XCTAssertGreaterThanOrEqual(audio.mediaPosition, 0.79)
        XCTAssertLessThanOrEqual(audio.mediaPosition, 0.83)
        audio.clear()
        XCTAssertFalse(audio.canPlay)
        XCTAssertEqual(audio.duration, 0)
    }

    @MainActor
    func testChangingAIReadingSelectionInvalidatesReviewAndRefusesAnOldDestination() throws {
        let model = RecastModel(toolsPath: "/invented-recast-fixture/tools")
        defer { model.stop() }
        let document = try file()
        model.install(RecastState(file: document, assets: [:]))
        model.proposalReadingIDs = ["reading_first"]
        let review = RecastProposalReview(documentId: document.id, revision: document.revision,
            collectionId: "table", sourceIds: ["source_fixture"], readingIds: ["reading_first"],
            contextHash: "fixture", explanation: "", records: [], warnings: [])
        model.proposal = review
        let firstRequest = model.proposalRequestID
        model.proposalReadingIDs.insert("reading_second")
        XCTAssertNil(model.proposal)
        XCTAssertNotEqual(model.proposalRequestID, firstRequest)
        model.proposal = review
        model.applyProposal()
        XCTAssertFalse(model.busy)
        XCTAssertTrue(model.error?.contains("selected input changed") == true)
        model.proposalReadingIDs = ["reading_first"]
        model.selectedCollection = "absent_collection"
        model.proposal = review
        model.applyProposal()
        XCTAssertFalse(model.busy)
        XCTAssertTrue(model.error?.contains("selected input changed") == true)
        model.showAIProposal = true
        model.busy = true
        model.proposalReadingIDs.insert("reading_late")
        XCTAssertFalse(model.busy, "A changed selection must cancel the transaction before an async commit")
        model.busy = true
        model.selectedCollection = "table"
        XCTAssertFalse(model.busy, "A changed destination must cancel the transaction before an async commit")
        let beforeCancel = model.proposalRequestID
        model.cancel()
        XCTAssertNotEqual(model.proposalRequestID, beforeCancel)
    }

    func testReaderCancellationDoesNotReturnLatePreview() async throws {
        let task = Task {
            try Task.checkCancellation()
            return try await NativeSourceReader.shared.preview(data: Data(), kind: "image", page: 0)
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A cancelled preview must not produce output")
        } catch is CancellationError {
            XCTAssertTrue(task.isCancelled)
        } catch {
            // A task may start before cancel; malformed input remains a failure, never a successful preview.
            XCTAssertTrue(task.isCancelled)
        }
    }
}

extension RecastTests {
    private func evidenceFixture() throws -> RecastState {
        var document = try file()
        let timetable = Data("08:10".utf8)
        let note = Data("Allow 20 minutes".utf8)
        let first = source(timetable)
        var second = source(note)
        second.id = "source_note"; second.name = "Transfer note.txt"
        document.sources = [first, second]
        document.anchors = [first, second].enumerated().map { index, source in
            RecastAnchor(id: "region_\(index)", sourceId: source.id, sourceHash: source.contentHash,
                label: index == 0 ? "Departure" : "Transfer", region: RecastRegion(kind: "text", start: 0,
                    end: source.textLength, quote: index == 0 ? "08:10" : "Allow 20 minutes", prefix: "", suffix: ""))
        }
        document.readings = document.anchors.enumerated().map { index, anchor in
            RecastReading(id: "reading_\(index)", anchorId: anchor.id, text: anchor.region.quote ?? "",
                alternatives: index == 0 ? ["08:40"] : [], method: "manual", engine: "Fixture", createdAt: "2026-01-01T12:00:00Z")
        }
        document.records = [RecastRecord(id: "record_fixture", collectionId: "table", state: "accepted", cells: [
            "name": RecastCell(value: .string("08:40"), state: "accepted", origin: "inferred", anchorIds: ["region_0"],
                readingIds: ["reading_0"], alternatives: [.string("08:10")], note: "Reviewed departure")
        ], createdAt: "2026-01-01T12:00:00Z")]
        return RecastState(file: document, assets: [first.assetName: timetable, second.assetName: note])
    }

    @MainActor
    func testEvidenceSelectionStagesMultipleReadingsAndRejectsStaleOwners() throws {
        let state = try evidenceFixture()
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(state)
        model.openEvidence()
        let draft = try XCTUnwrap(model.evidenceDraft)
        var selection = draft.selection
        selection.selectReading(state.file.readings[1], selected: true)
        XCTAssertEqual(selection.anchorIds, ["region_0", "region_1"])
        XCTAssertEqual(selection.readingIds, ["reading_0", "reading_1"])
        XCTAssertEqual(model.cell?.anchorIds, ["region_0"])
        XCTAssertEqual(model.cell?.value, .string("08:40"))
        XCTAssertEqual(try model.evidenceOperations(draft: draft, selection: selection, reason: "Transfer context").count, 1)
        selection.selectAnchor(draft.choices[1], selected: false)
        XCTAssertEqual(selection.readingIds, ["reading_0"])
        selection.selectReading(state.file.readings[0], selected: false)
        XCTAssertEqual(selection.anchorIds, ["region_0"])
        XCTAssertTrue(selection.readingIds.isEmpty)

        model.selectedField = "other"
        XCTAssertThrowsError(try model.evidenceOperations(draft: draft, selection: selection, reason: "Fixture"))
        model.selectedField = "name"
        model.selectedRecord = "other"
        XCTAssertThrowsError(try model.evidenceOperations(draft: draft, selection: selection, reason: "Fixture"))
        model.selectedRecord = "record_fixture"
        var other = state
        other.file.id = "another_document"
        model.install(other)
        XCTAssertThrowsError(try model.evidenceOperations(draft: draft, selection: selection, reason: "Fixture"))
        model.install(state)
        model.openEvidence()
        XCTAssertThrowsError(try model.evidenceOperations(draft: draft, selection: selection, reason: "Closed sheet"))
    }

    @MainActor
    func testDroppedEvidenceRefusesCrossDocumentAndOldLinksAndOnlyStagesAValidLink() throws {
        let state = try evidenceFixture()
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(state)
        XCTAssertFalse(model.receiveEvidence([RecastEvidenceLink(documentId: "other", revision: 0, anchorId: "region_1")], recordId: "record_fixture", fieldId: "name"))
        XCTAssertNil(model.evidenceDraft)
        XCTAssertFalse(model.receiveEvidence([RecastEvidenceLink(documentId: state.file.id, revision: 1, anchorId: "region_1")], recordId: "record_fixture", fieldId: "name"))
        XCTAssertTrue(model.receiveEvidence([RecastEvidenceLink(documentId: state.file.id, revision: 0, anchorId: "region_1")], recordId: "record_fixture", fieldId: "name"))
        XCTAssertEqual(model.evidenceDraft?.selection.anchorIds, ["region_0", "region_1"])
        XCTAssertEqual(model.file?.revision, 0)
        XCTAssertEqual(model.cell?.anchorIds, ["region_0"])
    }

    @MainActor
    func testSelectedTextIsStagedWithItsOwnRegionBeforeOneApplyTransaction() throws {
        let state = try evidenceFixture()
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(state)
        model.sourceText = "08:10"; model.sourceTextOffset = 0; model.previewBusy = false
        model.textSelection = NSRange(location: 0, length: 5)
        model.attachSelectedRegion()
        let draft = try XCTUnwrap(model.evidenceDraft)
        XCTAssertEqual(draft.addedReading?.text, "08:10")
        XCTAssertEqual(draft.addedReading?.anchorId, draft.addedAnchor?.id)
        XCTAssertEqual(draft.addedAnchor?.region.end, 5)
        XCTAssertEqual(model.file?.anchors.count, 2)
        XCTAssertEqual(try model.evidenceOperations(draft: draft, selection: draft.selection, reason: "New selection").count, 2)
    }

    @MainActor
    func testEvidenceApplyUndoRedoAndPackageReopenThroughProductionCLI() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let document = RecastDocument()
        let model = document.model
        defer { model.onReady = nil; model.stop() }
        let state = try evidenceFixture()
        model.install(state)
        model.openEvidence()
        let draft = try XCTUnwrap(model.evidenceDraft)
        var selection = draft.selection
        selection.selectReading(state.file.readings[1], selected: true)
        let operations = try model.evidenceOperations(draft: draft, selection: selection, reason: "Transfer context")
        let undo = try XCTUnwrap(document.undoManager)
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        try await model.apply(operations, title: "Change field evidence")
        undo.endUndoGrouping()
        XCTAssertEqual(model.cell?.readingIds, ["reading_0", "reading_1"])
        XCTAssertEqual(model.cell?.state, "proposed")
        XCTAssertEqual(model.cell?.value, .string("08:40"))
        XCTAssertEqual(model.file?.corrections.last?.reason, "Transfer context")
        let saved = try RecastPackage.encode(XCTUnwrap(model.state))
        let reopened = try RecastPackage.decode(saved)
        XCTAssertEqual(reopened.file.records[0].cells["name"]?.readingIds, ["reading_0", "reading_1"])
        XCTAssertEqual(reopened.assets, state.assets)
        XCTAssertEqual(reopened.file.readings[0].alternatives, ["08:40"])

        let undone = expectation(description: "Evidence undo inspected")
        model.onReady = {
            if model.file?.revision == 0 && !model.busy { model.onReady = nil; undone.fulfill() }
        }
        undo.undo()
        await fulfillment(of: [undone], timeout: 15)
        XCTAssertEqual(model.cell?.readingIds, ["reading_0"])
        XCTAssertEqual(model.cell?.state, "accepted")
        XCTAssertTrue(undo.canRedo)
        let redone = expectation(description: "Evidence redo inspected")
        model.onReady = {
            if model.file?.revision == 1 && !model.busy { model.onReady = nil; redone.fulfill() }
        }
        undo.redo()
        await fulfillment(of: [redone], timeout: 15)
        XCTAssertEqual(model.cell?.readingIds, ["reading_0", "reading_1"])
        XCTAssertEqual(model.cell?.state, "proposed")
        XCTAssertEqual(model.assets, state.assets)
    }
}

extension RecastTests {
    @MainActor
    func testCompetingEvidenceDecisionUsesProductionCLIAndOneUndoRestoresBothRecords() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let document = RecastDocument()
        let model = document.model
        defer { model.onReady = nil; model.stop() }
        var state = try evidenceFixture()
        var other = state.file.records[0]
        other.id = "record_other"
        other.cells["name"]?.value = .string("08:10")
        state.file.records.append(other)
        model.install(state)
        model.openContradiction()
        let draft = try XCTUnwrap(model.contradictionDraft)
        let operations = try model.contradictionOperations(draft: draft, fieldId: "name",
            records: ["record_fixture", "record_other"], label: "Departure", reason: "Use the reviewed departure",
            decision: "prefer", preferred: "record_fixture", contexts: [:])
        XCTAssertEqual(operations.count, 2)
        let undo = try XCTUnwrap(document.undoManager)
        undo.groupsByEvent = false
        undo.beginUndoGrouping()
        try await model.apply(operations, title: "Resolve departure")
        undo.endUndoGrouping()
        XCTAssertEqual(model.file?.version, 2)
        XCTAssertEqual(model.file?.contradictions?.first?.preferredRecordId, "record_fixture")
        XCTAssertEqual(model.file?.records[1].state, "archived")
        XCTAssertEqual(model.file?.records[1].cells["name"]?.value, .string("08:10"))
        let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
        XCTAssertEqual(reopened.file.contradictions?.first?.members.count, 2)
        XCTAssertEqual(reopened.file.contradictions?.first?.members[0].cell.readingIds, ["reading_0"])
        XCTAssertEqual(reopened.assets, state.assets)
        let undone = expectation(description: "Competing decision undo inspected")
        model.onReady = { if model.file?.revision == state.file.revision && !model.busy { model.onReady = nil; undone.fulfill() } }
        undo.undo()
        await fulfillment(of: [undone], timeout: 15)
        XCTAssertEqual(model.file?.records[1].state, "accepted")
        XCTAssertTrue(model.file?.contradictions?.isEmpty == true)
        XCTAssertThrowsError(try model.contradictionOperations(draft: draft, fieldId: "name",
            records: ["record_fixture", "record_other"], label: "Departure", reason: "Old comparison",
            decision: "keep-both", preferred: "", contexts: [:]))
    }

    @MainActor
    func testContradictionDraftRejectsMissingContextsAndDifferentDocument() throws {
        var state = try evidenceFixture()
        var other = state.file.records[0]; other.id = "record_other"; state.file.records.append(other)
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(state); model.openContradiction()
        let draft = try XCTUnwrap(model.contradictionDraft)
        XCTAssertThrowsError(try model.contradictionOperations(draft: draft, fieldId: "name",
            records: ["record_fixture", "record_other"], label: "Departure", reason: "Different days",
            decision: "context", preferred: "", contexts: ["record_fixture": "Weekdays"]))
        var changed = state; changed.file.id = "other_document"; model.install(changed)
        XCTAssertThrowsError(try model.contradictionOperations(draft: draft, fieldId: "name",
            records: ["record_fixture", "record_other"], label: "Departure", reason: "Other document",
            decision: "keep-both", preferred: "", contexts: [:]))
        var invalid = state; invalid.file.version = 1; invalid.file.contradictions = []
        XCTAssertThrowsError(try RecastPackage.encode(invalid))
        invalid.file.version = 3
        XCTAssertThrowsError(try RecastPackage.encode(invalid))
    }

    @MainActor
    func testRealImageOCRReturnsOnlySelectedTimetableRegionWithSourceBounds() async throws {
        let bitmap = try XCTUnwrap(CGContext(data: nil, width: 1000, height: 600, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1)); bitmap.fill(CGRect(x: 0, y: 0, width: 1000, height: 600))
        let font = CTFontCreateWithName("Helvetica" as CFString, 46, nil)
        for (text, y) in [("Example timetable 08:40", 410.0), ("Unselected private fixture 11:20", 110.0)] {
            bitmap.textPosition = CGPoint(x: 50, y: y)
            CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
            ])), bitmap)
        }
        let image = try XCTUnwrap(bitmap.makeImage())
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        let region = NativeSourceRect(x: 0, y: 0.5, width: 1, height: 0.5)
        let result = try await NativeSourceReader.shared.extract(data: png, kind: "image", page: 0, region: region)
        let text = result.blocks.map(\.text).joined(separator: " ")
        XCTAssertEqual(result.method, "vision-ocr")
        XCTAssertEqual(result.engine, "Apple Vision")
        XCTAssertTrue(text.contains("08:40"), text)
        XCTAssertFalse(text.contains("11:20"), text)
        XCTAssertFalse(result.blocks.isEmpty)
        for block in result.blocks {
            let bounds = try XCTUnwrap(block.bounds)
            XCTAssertTrue(bounds.isValid)
            XCTAssertGreaterThanOrEqual(bounds.y, 0.5)
        }
        let preview = try await NativeSourceReader.shared.preview(data: png, kind: "image", page: 0)
        let fingerprints = try await NativeSourceReader.shared.regionFingerprints(preview: preview,
            regions: [region, region, NativeSourceRect(x: 0, y: 0, width: 1, height: 0.5)])
        XCTAssertEqual(fingerprints[0], fingerprints[1])
        XCTAssertEqual(fingerprints[0].count, 64)
        XCTAssertNotEqual(fingerprints[0], fingerprints[2])
        XCTAssertNotEqual(fingerprints[0], String(repeating: "0", count: 64))
        let cancelled = Task { try await NativeSourceReader.shared.regionFingerprints(preview: preview, regions: [region]) }
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Cancelled comparison returned late data") }
        catch { XCTAssertTrue(error is CancellationError) }

        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let model = RecastModel(toolsPath: root.appendingPathComponent("tools").path)
        defer { model.onReady = nil; model.stop() }
        var document = try file()
        var imageSource = source(png)
        imageSource.kind = "image"; imageSource.name = "Example timetable.png"; imageSource.mime = "image/png"
        imageSource.assetName = imageSource.contentHash + ".png"; imageSource.textLength = nil; imageSource.pageCount = 1
        imageSource.pages = try JSONDecoder().decode([NativeSourcePage].self, from: Data(#"[{"index":0,"width":1000,"height":600}]"#.utf8))
        document.sources = [imageSource]
        model.install(RecastState(file: document, assets: [imageSource.assetName: png]))
        model.selectedRegion = region
        let captured = expectation(description: "Real OCR captured with source fingerprints")
        model.onReady = {
            if !model.busy && !model.file!.anchors.isEmpty { model.onReady = nil; captured.fulfill() }
        }
        model.extractSelection(intoField: false)
        await fulfillment(of: [captured], timeout: 15)
        XCTAssertNil(model.error)
        let readAnchors = Set(model.file?.readings.map(\.anchorId) ?? [])
        XCTAssertFalse(readAnchors.isEmpty)
        XCTAssertTrue(model.file?.anchors.filter { readAnchors.contains($0.id) }.allSatisfy { $0.fingerprint?.count == 64 } == true)
        XCTAssertTrue(model.file?.anchors.contains { $0.label == "Selected for interpretation" } == true)
        XCTAssertTrue(model.file?.readings.map(\.text).joined(separator: " ").contains("08:40") == true)
        XCTAssertEqual(model.assets[imageSource.assetName], png)
        if let output = ProcessInfo.processInfo.environment["RECAST_CAPABILITY_DIR"] {
            let folder = URL(fileURLWithPath: output, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try RecastPackage.encode(XCTUnwrap(model.state)).write(to: folder.appendingPathComponent("Real-OCR.recast"),
                options: .atomic, originalContentsURL: nil)
            try png.write(to: folder.appendingPathComponent("Timetable.png"), options: .atomic)
            try JSONEncoder().encode(result).write(to: folder.appendingPathComponent("Reading.json"), options: .atomic)
        }
        print("Recast OCR capability: " + ProcessInfo.processInfo.operatingSystemVersionString + "; " + text)
    }
}

extension RecastTests {
    @MainActor
    func testInferenceCheckpointAutosavesManualCorrectionAndSelectedRegionToRealPackage() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-recovery-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { do { try FileManager.default.removeItem(at: folder) } catch { XCTFail("Fixture cleanup failed: \(error)") } }
        let url = folder.appendingPathComponent("Recovery.recast")
        let state = try evidenceFixture()
        try RecastPackage.encode(state).write(to: url, options: .atomic, originalContentsURL: nil)
        let document = try RecastDocument(contentsOf: url, ofType: RecastPackage.type)
        NSDocumentController.shared.addDocument(document)
        defer { document.model.stop(); NSDocumentController.shared.removeDocument(document); document.close() }
        var cell = try XCTUnwrap(document.model.cell)
        cell.value = .string("08:50"); cell.origin = "user"; cell.state = "proposed"
        try await document.model.apply([recastOperation("set-cell", ["recordId": .string("record_fixture"),
            "fieldId": .string("name"), "cell": try .encoded(cell), "reason": .string("Saved manual correction")])], title: "Manual correction")
        let anchor = RecastAnchor(id: "saved_selection", sourceId: state.file.sources[0].id,
            sourceHash: state.file.sources[0].contentHash, label: "Selection before inference", region: state.file.anchors[0].region)
        let checkpoint = try await document.model.checkpointForInference(anchor: anchor)
        let recovered = try RecastPackage.load(url)
        XCTAssertEqual(recovered.file.revision, checkpoint.revision)
        XCTAssertEqual(recovered.file.records[0].cells["name"]?.value, .string("08:50"))
        XCTAssertEqual(recovered.file.corrections.last?.reason, "Saved manual correction")
        XCTAssertEqual(recovered.file.anchors.last?.id, "saved_selection")
        XCTAssertEqual(recovered.assets, state.assets)
        XCTAssertFalse(document.isDocumentEdited)
        if let output = ProcessInfo.processInfo.environment["RECAST_CAPABILITY_DIR"] {
            let target = URL(fileURLWithPath: output, isDirectory: true).appendingPathComponent("Saved-recovery.recast")
            try RecastPackage.encode(recovered).write(to: target, options: .atomic, originalContentsURL: nil)
        }
    }

    func testInferenceSlotsBoundConcurrentJobsAndReleaseAfterCancellationAndDeadline() async throws {
        let slots = RecastInferenceSlots(limit: 2, timeoutNanoseconds: 100_000_000)
        let first = try await slots.acquire(), second = try await slots.acquire()
        let active = await slots.activeCount
        XCTAssertEqual(active, 2)
        let cancelled = Task { try await slots.acquire() }
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Cancelled queued job acquired a slot") }
        catch { XCTAssertTrue(error is CancellationError) }
        do { _ = try await slots.acquire(); XCTFail("Queued job outlived its deadline") }
        catch { XCTAssertTrue(error.localizedDescription.contains("already running")) }
        let countAfterCancel = await slots.activeCount
        XCTAssertEqual(countAfterCancel, 2)
        await slots.release(first)
        let normal = try await slots.acquire()
        let countAfterAcquire = await slots.activeCount
        XCTAssertEqual(countAfterAcquire, 2)
        await slots.release(second); await slots.release(normal)
        let final = await slots.activeCount
        XCTAssertEqual(final, 0)
    }
}

extension RecastTests {
    @MainActor
    func testUntitledInferenceCheckpointCreatesNativeCrashRecoveryContents() async throws {
        let document = RecastDocument()
        NSDocumentController.shared.addDocument(document)
        defer { document.model.stop(); NSDocumentController.shared.removeDocument(document); document.close() }
        let state = try evidenceFixture()
        document.model.install(state)
        document.updateChangeCount(.changeDone)
        _ = try await document.model.checkpointForInference()
        let recovery = try XCTUnwrap(document.autosavedContentsFileURL)
        let reopened = try RecastPackage.load(recovery)
        XCTAssertEqual(reopened.file.records[0].cells["name"]?.value, .string("08:40"))
        XCTAssertEqual(reopened.assets, state.assets)
        XCTAssertNil(document.fileURL)
    }
}

extension RecastTests {
    @MainActor
    func testInferenceLaunchRefusesStaleInputBeforeProviderPrimitiveAndNormalUseStillSpawns() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-inference-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("src/recast"), withIntermediateDirectories: true)
        defer { do { try FileManager.default.removeItem(at: folder) } catch { XCTFail("Fixture cleanup failed: \(error)") } }
        let marker = folder.appendingPathComponent("provider-started.txt")
        let encodedPath = try XCTUnwrap(String(data: JSONEncoder().encode(marker.path), encoding: .utf8))
        let script = "#!/usr/bin/env bun\nawait Bun.write(\(encodedPath), 'started'); throw new Error('Fixture provider reached');"
        try Data(script.utf8).write(to: folder.appendingPathComponent("src/recast/index.ts"), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.appendingPathComponent("src/recast/index.ts").path)
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = folder.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let state = try evidenceFixture()
        let url = folder.appendingPathComponent("Guard.recast")
        try RecastPackage.encode(state).write(to: url, options: .atomic, originalContentsURL: nil)
        let document = try RecastDocument(contentsOf: url, ofType: RecastPackage.type)
        NSDocumentController.shared.addDocument(document)
        defer { document.model.stop(); NSDocumentController.shared.removeDocument(document); document.close() }
        var changed = state; changed.file.revision += 1
        document.model.install(changed); document.updateChangeCount(.changeDone)
        do { _ = try await document.model.command("propose", file: state.file); XCTFail("Stale generation was launched") }
        catch { XCTAssertTrue(error.localizedDescription.contains("changed before interpretation")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        let saved = try RecastPackage.load(url)
        XCTAssertEqual(saved.file.revision, changed.file.revision)
        do { _ = try await document.model.command("propose", file: changed.file); XCTFail("Fixture provider must throw") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Fixture provider reached"), error.localizedDescription) }
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "started")
    }
}

extension RecastTests {
    @MainActor
    func testBulkCorrectionIsOneProductionTransactionWithEvidenceAndUndo() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let document = RecastDocument(), model = document.model
        defer { model.onReady = nil; model.stop() }
        var state = try evidenceFixture()
        var other = state.file.records[0]; other.id = "record_other"; other.cells["name"]?.value = .string("08:10")
        state.file.records.append(other)
        model.install(state)
        model.markRecord("record_fixture", checked: true); model.markRecord("record_other", checked: true)
        model.openBulk()
        let draft = try XCTUnwrap(model.bulkDraft)
        XCTAssertEqual(draft.records.count, 2)
        let operation = try model.bulkOperation(draft: draft, fieldId: "name", text: "08:50", unknown: false,
            note: "User supplied fixture time", reason: "Fixture batch")
        let undo = try XCTUnwrap(document.undoManager)
        undo.groupsByEvent = false; undo.beginUndoGrouping()
        try await model.apply([operation], title: "Correct two records")
        undo.endUndoGrouping()
        XCTAssertEqual(model.file?.revision, state.file.revision + 1)
        XCTAssertEqual(model.file?.corrections.count, 2)
        XCTAssertTrue(model.records.allSatisfy { $0.cells["name"]?.value == .string("08:50") && $0.state == "draft" })
        XCTAssertTrue(model.records.allSatisfy { $0.cells["name"]?.anchorIds == ["region_0"] && $0.cells["name"]?.readingIds == ["reading_0"] })
        XCTAssertEqual(model.file?.readings[0].alternatives, ["08:40"])
        let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
        XCTAssertEqual(reopened.file.records[1].cells["name"]?.value, .string("08:50"))
        XCTAssertEqual(reopened.assets, state.assets)
        let undone = expectation(description: "Bulk undo inspected")
        model.onReady = { if model.file?.revision == 0 && !model.busy { model.onReady = nil; undone.fulfill() } }
        undo.undo()
        await fulfillment(of: [undone], timeout: 15)
        XCTAssertEqual(model.records[0].cells["name"]?.value, .string("08:40"))
        XCTAssertEqual(model.records[1].cells["name"]?.value, .string("08:10"))
        XCTAssertThrowsError(try model.bulkOperation(draft: draft, fieldId: "name", text: "08:50", unknown: false,
            note: "", reason: "Old batch"))
    }

    @MainActor
    func testUnsupportedOriginalAttachmentIsExplicitAndHasNoFabricatedReading() throws {
        var state = try evidenceFixture()
        var original = state.file.sources[0]
        original.kind = "unsupported"; original.textLength = nil; original.error = "Unreadable invented source"
        state.file.sources = [original]; state.file.anchors = []; state.file.readings = []
        state.file.records[0].cells["name"] = RecastCell(value: .string("Manual observation"), state: "accepted", origin: "user")
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        model.install(state); model.previewBusy = false
        model.attachSelectedRegion()
        let draft = try XCTUnwrap(model.evidenceDraft)
        XCTAssertEqual(draft.addedAnchor?.region.kind, "whole")
        XCTAssertEqual(draft.addedAnchor?.sourceHash, original.contentHash)
        XCTAssertNil(draft.addedReading)
        XCTAssertEqual(model.cell?.value, .string("Manual observation"))
        XCTAssertEqual(model.cell?.origin, "user")
        XCTAssertEqual(try model.evidenceOperations(draft: draft, selection: draft.selection, reason: "Preserved unreadable original").count, 2)
        let number = RecastField(id: "number", label: "Number", type: "number", required: true)
        XCTAssertEqual(try RecastModel.manualCellValue(text: "0", unknown: false, field: number), .number(0))
        XCTAssertThrowsError(try RecastModel.manualCellValue(text: "not a number", unknown: false, field: number))
        XCTAssertEqual(try RecastModel.manualCellValue(text: "", unknown: true, field: number), .null)
    }
}

extension RecastTests {
    @MainActor
    func testSourceLocalCorrectionReviewProposesOnCurrentEvidenceAndRejectsOldScope() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let document = RecastDocument(), model = document.model
        defer { model.onReady = nil; model.stop() }
        let state = try evidenceFixture()
        model.install(state)
        var corrected = try XCTUnwrap(model.cell)
        corrected.value = .string("08:50"); corrected.origin = "user"; corrected.state = "proposed"
        try await model.apply([recastOperation("set-cell", ["recordId": .string("record_fixture"), "fieldId": .string("name"),
            "cell": try .encoded(corrected), "reason": .string("Human inspected the same source")])], title: "Human correction")
        var next = state.file.records[0]
        next.id = "record_next"; next.state = "draft"; next.cells["name"]?.value = .string("08:10")
        next.cells["name"]?.origin = "source"; next.cells["name"]?.state = "proposed"
        try await model.apply([recastOperation("add-proposals", ["records": try .encoded([next])])], title: "Add next reading")
        model.selectField(recordId: next.id, fieldId: "name")
        let inspected = expectation(description: "Source-local correction inspected")
        model.onReady = { if model.correctionExamples != nil && !model.busy { model.onReady = nil; inspected.fulfill() } }
        model.openCorrectionExamples()
        await fulfillment(of: [inspected], timeout: 15)
        let preview = try XCTUnwrap(model.correctionExamples)
        XCTAssertEqual(preview.examples.count, 1)
        XCTAssertEqual(preview.examples[0].value, .string("08:50"))
        XCTAssertEqual(model.cell?.value, .string("08:10"))
        let operation = try model.correctionExampleOperation(preview: preview, correctionId: preview.examples[0].id)
        try await model.apply([operation], title: "Propose local correction")
        XCTAssertEqual(model.cell?.value, .string("08:50"))
        XCTAssertEqual(model.cell?.origin, "inferred")
        XCTAssertEqual(model.cell?.state, "proposed")
        XCTAssertEqual(model.cell?.anchorIds, ["region_0"])
        XCTAssertEqual(model.cell?.readingIds, ["reading_0"])
        XCTAssertEqual(model.file?.readings[0].text, "08:10")
        let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
        XCTAssertEqual(reopened.file.records[1].cells["name"]?.origin, "inferred")
        XCTAssertEqual(reopened.assets, state.assets)
        XCTAssertThrowsError(try model.correctionExampleOperation(preview: preview, correctionId: preview.examples[0].id))
    }
}

extension RecastTests {
    @MainActor
    func testRememberingExportCannotRestoreAnotherCollectionsPreview() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let model = RecastModel(toolsPath: root.appendingPathComponent("tools").path)
        defer { model.stop() }
        var reviewed = try evidenceFixture()
        reviewed.file.records[0].state = "accepted"
        reviewed.file.records[0].cells["name"]?.state = "accepted"
        var other = reviewed.file.collections[0]; other.id = "other"
        reviewed.file.collections.append(other)
        model.install(reviewed)
        let rendered = try JSONDecoder().decode(RecastRendering.self, from: Data(try await model.command("render",
            file: reviewed.file, arguments: ["--collection", "table", "--format", "csv"]).utf8))
        try await model.rememberRendering(rendered)
        XCTAssertEqual(model.rendering?.contentHash, rendered.contentHash, "Normal receipt saving keeps its preview")
        model.install(reviewed)
        let remembering = Task { try await model.rememberRendering(rendered) }
        model.selectedCollection = "other"
        try await remembering.value
        XCTAssertTrue(model.file?.renderings?.contains { $0.id == rendered.receipt.id } == true,
            "The export receipt remains valid even after choosing another collection")
        XCTAssertNil(model.rendering, "Saving a receipt must not restore the previous collection's preview")
    }

    @MainActor
    func testExportDiscardsResultsAfterSelectionChangesAwayAndBack() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let model = RecastModel(toolsPath: root.appendingPathComponent("tools").path)
        defer { model.stop() }
        var reviewed = try evidenceFixture()
        reviewed.file.records[0].state = "accepted"
        reviewed.file.records[0].cells["name"]?.state = "accepted"
        var other = reviewed.file.collections[0]; other.id = "other"
        reviewed.file.collections.append(other)
        model.install(reviewed)
        let done = expectation(description: "Obsolete render finishes")
        let subscription = model.$busy.dropFirst().filter { !$0 }.prefix(1).sink { _ in done.fulfill() }
        model.prepareExport(presentSheet: false)
        model.selectedCollection = "other"
        model.selectedCollection = "table"
        await fulfillment(of: [done], timeout: 15)
        subscription.cancel()
        XCTAssertNil(model.rendering)
        XCTAssertNil(model.error)
    }

    @MainActor
    func testBlockedDestinationOpensWithRequiredFieldsAndCannotReuseOldRendering() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let model = RecastModel(toolsPath: root.appendingPathComponent("tools").path)
        defer { model.stop() }
        var reviewed = try evidenceFixture()
        reviewed.file.records[0].state = "accepted"
        reviewed.file.records[0].cells["name"]?.state = "accepted"
        model.install(reviewed)
        let rendered = try JSONDecoder().decode(RecastRendering.self, from: Data(try await model.command("render",
            file: reviewed.file, arguments: ["--collection", "table", "--format", "csv"]).utf8))
        model.rendering = rendered
        var missing = reviewed
        missing.file.records[0].state = "draft"
        missing.file.records[0].cells["name"]?.value = .null
        missing.file.records[0].cells["name"]?.state = "unknown"
        model.install(missing)
        XCTAssertNil(model.rendering)
        let inspection = try await model.command("inspect", file: missing.file)
        model.issues = try JSONDecoder().decode(RecastInspection.self, from: Data(inspection.utf8)).issues
        model.rendering = rendered
        let completed = expectation(description: "Blocked render finishes")
        let subscription = model.$busy.dropFirst().filter { !$0 }.prefix(1).sink { _ in completed.fulfill() }
        model.prepareExport()
        XCTAssertTrue(model.showExport)
        XCTAssertNil(model.rendering)
        await fulfillment(of: [completed], timeout: 15)
        subscription.cancel()
        XCTAssertNil(model.rendering)
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.destinationIssues.contains { $0.message == "Name is required." })
        model.install(reviewed); model.showExport = false
        let ready = expectation(description: "Inline render finishes")
        let successSubscription = model.$busy.dropFirst().filter { !$0 }.prefix(1).sink { _ in ready.fulfill() }
        model.prepareExport(presentSheet: false)
        await fulfillment(of: [ready], timeout: 15)
        successSubscription.cancel()
        XCTAssertNotNil(model.rendering)
        XCTAssertFalse(model.showExport)
        XCTAssertNil(model.error)
        model.workspaceWidth = 900
        XCTAssertEqual(RecastWorkspaceMode.split.effective(width: 900), .objects)
        XCTAssertEqual(RecastWorkspaceMode.split.effective(width: 1460), .split)
        let record = model.selectedRecord
        model.workspaceMode = .objects; model.revealSelectedEvidence()
        XCTAssertEqual(model.workspaceMode, .source)
        XCTAssertEqual(model.selectedRecord, record)
        XCTAssertEqual(model.selectedAnchor, "region_0")
    }
}

extension RecastTests {
    func testSharedAssetCannotBypassSourceHashIdentity() throws {
        var state = try evidenceFixture()
        var copy = state.file.sources[0]
        copy.id = "source_copy"; copy.name = "Copy.txt"
        state.file.sources.append(copy)
        XCTAssertEqual(try RecastPackage.decode(RecastPackage.encode(state)).file.sources.count, 3)
        state.file.sources[2].contentHash = String(repeating: "f", count: 64)
        let wrappers = try RecastPackage.encode(state)
        XCTAssertThrowsError(try RecastPackage.decode(wrappers))
    }
}

extension RecastTests {
    @MainActor
    func testPublishedExamplesOpenAsIndependentConversionsWithoutChangingFixture() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        for example in RecastExample.allCases {
            let fixture = root.appendingPathComponent("src/recast/fixtures/\(example.rawValue).recast")
            let manifest = fixture.appendingPathComponent("manifest.json")
            let original = try Data(contentsOf: manifest)
            let document = RecastDocument(), model = document.model
            defer { model.onReady = nil; model.stop() }
            model.install(RecastState(file: try file(), assets: [:]))
            let opened = expectation(description: "Independent example loaded")
            model.onReady = { if !model.busy && model.file?.sources.isEmpty == false { model.onReady = nil; opened.fulfill() } }
            model.openExample(example)
            await fulfillment(of: [opened], timeout: 15)
            XCTAssertNil(document.fileURL)
            XCTAssertTrue(document.isDocumentEdited)
            XCTAssertFalse(model.assets.isEmpty)
            XCTAssertTrue(model.records.allSatisfy { $0.state == "draft" })
            XCTAssertEqual(try Data(contentsOf: manifest), original)
            let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
            XCTAssertEqual(reopened.assets, model.assets)
            let revision = model.file?.revision
            model.openExample(example)
            XCTAssertEqual(model.file?.revision, revision)
            XCTAssertEqual(model.error, "Open a new conversion to try an example.")
        }
    }
}

private actor RecastPreviewDecodeProbe {
    private(set) var pages: [Int] = []
    func decode(_ request: RecastPreviewRequest) async throws -> Data {
        pages.append(request.page)
        return try await NativeSourceReader.shared.preview(data: request.data, kind: request.kind, page: request.page)
    }
}

extension RecastTests {
    @MainActor
    private func previewPDF() throws -> Data {
        let image = NSImage(size: NSSize(width: 160, height: 90))
        image.lockFocus()
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 160, height: 90).fill()
        "Invented PDF page".draw(at: NSPoint(x: 10, y: 35), withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.black])
        image.unlockFocus()
        let pdf = PDFDocument()
        for index in 0..<100 { pdf.insert(try XCTUnwrap(PDFPage(image: image)), at: index) }
        return try XCTUnwrap(pdf.dataRepresentation())
    }

    @MainActor
    func testPreviewCacheDecodesOnlyRequestedPDFPagesAndEvictsItsOwnLeastRecentEntries() async throws {
        let original = try previewPDF(), hash = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recast-cache-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let sentinel = directory.appendingPathComponent("unrelated.txt")
        try Data("Keep unrelated files".utf8).write(to: sentinel)
        let probe = RecastPreviewDecodeProbe()
        let cache = RecastPreviewCache(directory: directory, budgetBytes: 1024 * 1024, maximumEntries: 2,
            decode: { try await probe.decode($0) })
        func request(_ page: Int) -> RecastPreviewRequest { RecastPreviewRequest(data: original, sourceHash: hash, kind: "pdf", page: page) }
        let first = try await cache.preview(request(0))
        let last = try await cache.preview(request(99))
        XCTAssertFalse(first.isEmpty); XCTAssertFalse(last.isEmpty)
        let reusedFirst = try await cache.preview(request(0))
        XCTAssertEqual(reusedFirst, first)
        let initialPages = await probe.pages
        XCTAssertEqual(initialPages, [0, 99])
        _ = try await cache.preview(request(1))
        _ = try await cache.preview(request(99))
        let decodedPages = await probe.pages
        XCTAssertEqual(decodedPages, [0, 99, 1, 99])
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            .filter { $0.lastPathComponent.hasPrefix("page-v1-") }
        XCTAssertEqual(files.count, 2)
        XCTAssertLessThanOrEqual(try files.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }, 1024 * 1024)
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("Keep unrelated files".utf8))
        XCTAssertEqual(SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined(), hash)
        let cold = RecastPreviewCache(directory: directory, maximumEntries: 2, decode: { _ in throw recastError("Cold cache should not decode") })
        let reopenedLast = try await cold.preview(request(99))
        XCTAssertEqual(reopenedLast, last)
    }

    @MainActor
    func testPreviewCacheRejectsCorruptionAndCannotExceedByteBudget() async throws {
        let original = try previewPDF(), hash = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recast-cache-\(UUID().uuidString)")
        let probe = RecastPreviewDecodeProbe()
        let cache = RecastPreviewCache(directory: directory, budgetBytes: 1024 * 1024, decode: { try await probe.decode($0) })
        let request = RecastPreviewRequest(data: original, sourceHash: hash, kind: "pdf", page: 0)
        let expected = try await cache.preview(request)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let cached = await cache.artifactURL(request)
        try Data("corrupt cache".utf8).write(to: cached)
        let repaired = try await cache.preview(request)
        XCTAssertEqual(repaired, expected)
        let decoded = await probe.pages
        XCTAssertEqual(decoded, [0, 0])
        let encodedSize = try cached.resourceValues(forKeys: [.fileSizeKey]).fileSize!
        let byteLimited = RecastPreviewCache(directory: directory, budgetBytes: encodedSize + 64,
            decode: { try await probe.decode($0) })
        _ = try await byteLimited.preview(RecastPreviewRequest(data: original, sourceHash: hash, kind: "pdf", page: 1))
        let retained = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
            .filter { $0.lastPathComponent.hasPrefix("page-v1-") }
        XCTAssertEqual(retained.count, 1)
        XCTAssertLessThanOrEqual(try retained.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }, encodedSize + 64)
        let tinyDirectory = directory.appendingPathComponent("tiny")
        let tiny = RecastPreviewCache(directory: tinyDirectory, budgetBytes: 8, decode: { try await probe.decode($0) })
        let uncached = try await tiny.preview(request)
        XCTAssertEqual(uncached, expected)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(at: tinyDirectory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("page-v1-") }.isEmpty)
        let cancelled = Task { try await cache.preview(request) }
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Cancelled preview should not return") }
        catch is CancellationError { XCTAssertTrue(cancelled.isCancelled) }
        catch { XCTFail("Expected cancellation, got \(error)") }
    }
}

extension RecastTests {
    @MainActor
    func testEvidenceDraftCannotBecomeCurrentAgainWhenAnInstallRestoresItsRevision() throws {
        let model = RecastModel(toolsPath: "/fixture/tools")
        defer { model.stop() }
        let state = try evidenceFixture()
        model.install(state); model.openEvidence()
        let draft = try XCTUnwrap(model.evidenceDraft)
        XCTAssertTrue(model.showEvidenceSheet)
        XCTAssertFalse(try model.evidenceOperations(draft: draft, selection: draft.selection, reason: "Current review").isEmpty)
        model.install(state)
        XCTAssertNil(model.evidenceDraft)
        XCTAssertFalse(model.showEvidenceSheet)
        XCTAssertThrowsError(try model.evidenceOperations(draft: draft, selection: draft.selection, reason: "Old review after undo or reload"))
    }
}

extension RecastTests {
    @MainActor
    func testBusyPreviewCacheLockFallsBackWithoutWritingAndNormalUseStillCaches() async throws {
        let original = try previewPDF(), hash = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recast-lock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let lockURL = directory.appendingPathComponent("page-v1.lock")
        let descriptor = lockURL.path.withCString { Darwin.open($0, O_CREAT | O_RDWR, mode_t(S_IRUSR | S_IWUSR)) }
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        guard descriptor >= 0 else { return }
        defer { Darwin.close(descriptor) }
        XCTAssertEqual(flock(descriptor, LOCK_EX | LOCK_NB), 0)
        let cache = RecastPreviewCache(directory: directory)
        let request = RecastPreviewRequest(data: original, sourceHash: hash, kind: "pdf", page: 0)
        let shown = try await cache.preview(request)
        XCTAssertFalse(shown.isEmpty)
        let artifact = await cache.artifactURL(request)
        XCTAssertFalse(FileManager.default.fileExists(atPath: artifact.path))
        XCTAssertEqual(flock(descriptor, LOCK_UN), 0)
        let cached = try await cache.preview(request)
        XCTAssertEqual(cached, shown)
        XCTAssertTrue(FileManager.default.fileExists(atPath: artifact.path))
    }
}

extension RecastTests {
    @MainActor
    func testDirectCSVReviewUsesProductionComparisonAndAtomicApplyUndoWithoutChangingOriginals() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        let document = RecastDocument(), model = document.model
        defer { model.onReady = nil; model.stop() }
        model.install(try evidenceFixture())
        let original = try XCTUnwrap(model.state)
        let rendered = try JSONDecoder().decode(RecastRendering.self, from: Data(try await model.command("render",
            file: original.file, arguments: ["--collection", "table", "--format", "csv"]).utf8))
        try await model.apply([recastOperation("record-rendering", ["receipt": try .encoded(rendered.receipt)])], title: "Remember baseline")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-native-csv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: folder) }
        let csv = folder.appendingPathComponent("edited.csv")
        XCTAssertTrue(rendered.text.contains("08:40"))
        try Data(rendered.text.replacingOccurrences(of: "08:40", with: "08:50").utf8).write(to: csv)
        let compared = expectation(description: "Production native CSV preview")
        model.onReady = { if !model.busy && model.roundTrip != nil { model.onReady = nil; compared.fulfill() } }
        model.reviewCSV(url: csv)
        await fulfillment(of: [compared], timeout: 15)
        let draft = try XCTUnwrap(model.roundTrip)
        XCTAssertEqual(draft.review.changes.count, 1)
        let change = try XCTUnwrap(draft.review.changes.first)
        XCTAssertEqual(change.base, .string("08:40")); XCTAssertEqual(change.current, .string("08:40"))
        XCTAssertEqual(change.incoming, .string("08:50"))
        XCTAssertEqual(model.cell?.value, .string("08:40"))
        XCTAssertEqual(model.assets, original.assets)
        let undo = try XCTUnwrap(document.undoManager)
        undo.groupsByEvent = false; undo.beginUndoGrouping()
        let applied = expectation(description: "Reviewed CSV applied")
        model.onReady = { if !model.busy && model.cell?.value == .string("08:50") { model.onReady = nil; applied.fulfill() } }
        model.applyCSVEdits(draft, changeIds: [change.id])
        await fulfillment(of: [applied], timeout: 15)
        undo.endUndoGrouping()
        XCTAssertNil(model.roundTrip)
        XCTAssertEqual(model.cell?.state, "proposed")
        XCTAssertEqual(model.record?.state, "draft")
        XCTAssertEqual(model.cell?.anchorIds, ["region_0"])
        XCTAssertEqual(model.cell?.readingIds, ["reading_0"])
        XCTAssertEqual(model.file?.readings[0].text, "08:10")
        let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
        XCTAssertEqual(reopened.assets, original.assets)
        XCTAssertEqual(reopened.file.records[0].cells["name"]?.value, .string("08:50"))
        let undone = expectation(description: "CSV transaction undone")
        model.onReady = { if !model.busy && model.cell?.value == .string("08:40") { model.onReady = nil; undone.fulfill() } }
        undo.undo()
        await fulfillment(of: [undone], timeout: 15)
        model.applyCSVEdits(draft, changeIds: [change.id])
        XCTAssertEqual(model.cell?.value, .string("08:40"))
        XCTAssertEqual(model.error, "The conversion changed. Compare this CSV again before applying edits.")
    }
}

extension RecastTests {
    @MainActor
    func testInstallingStateInvalidatesTranscriptEvenWhenUndoRestoresItsRevision() throws {
        let model = RecastModel(toolsPath: "/fixture/unused-tools")
        defer { model.stop() }
        let state = try evidenceFixture()
        model.install(state)
        let source = try XCTUnwrap(state.file.sources.first)
        let review = RecastTranscriptReview(id: "transcript_fixture", documentId: state.file.id,
            revision: state.file.revision, sourceId: source.id, sourceHash: source.contentHash,
            startMs: 0, endMs: 1000, text: "Invented transcript", engine: "fixture", language: "en",
            timing: "selection", segments: [], warnings: [])
        model.audioTranscript = review
        model.install(state)
        XCTAssertNil(model.audioTranscript)
        model.saveAudioTranscript(review, mode: "readings")
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.error, "The conversion changed. Transcribe this interval again before saving readings.")
        XCTAssertEqual(model.file?.readings.map(\.text), state.file.readings.map(\.text))
        XCTAssertEqual(model.assets, state.assets)
    }
}

extension RecastTests {
    @MainActor
    func testActiveTranscriptSavesThroughProductionCLIAndUndoRetainsTheAudio() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let previousTools = RecastConfiguration.toolsPath
        RecastConfiguration.toolsPath = root.appendingPathComponent("tools").path
        defer { RecastConfiguration.toolsPath = previousTools }
        var bytes = Data()
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
        }
        bytes.append(contentsOf: "RIFF".utf8); number(UInt32(64036))
        bytes.append(contentsOf: "WAVEfmt ".utf8); number(UInt32(16))
        number(UInt16(1)); number(UInt16(1)); number(UInt32(16000))
        number(UInt32(32000)); number(UInt16(2)); number(UInt16(16))
        bytes.append(contentsOf: "data".utf8); number(UInt32(64000))
        bytes.append(Data(repeating: 0, count: 64000))
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let original = RecastSource(id: "source_audio", name: "Invented silent fixture.wav", contentHash: hash,
            assetName: hash + ".wav", mime: "audio/wav", kind: "audio", bytes: bytes.count,
            importedAt: "2026-01-01T12:00:00Z", pages: [], durationMs: 2000)
        var file = try self.file()
        file.sources = [original]
        let initial = RecastState(file: file, assets: [original.assetName: bytes])
        let document = RecastDocument(), model = document.model
        model.audio.volume = 0
        defer { model.onReady = nil; model.stop() }
        model.install(initial)
        let review = RecastTranscriptReview(id: "transcript_active", documentId: file.id, revision: file.revision,
            sourceId: original.id, sourceHash: hash, startMs: 400, endMs: 800,
            text: "Invented transcript for capture", engine: "fixture", language: "en",
            timing: "selection", segments: [], warnings: [])
        model.audioTranscript = review
        let undo = try XCTUnwrap(document.undoManager)
        undo.groupsByEvent = false; undo.beginUndoGrouping()
        let saved = expectation(description: "Active transcript captured")
        model.onReady = { if !model.busy && model.file?.readings.count == 1 { model.onReady = nil; saved.fulfill() } }
        model.saveAudioTranscript(review, mode: "readings")
        await fulfillment(of: [saved], timeout: 15)
        undo.endUndoGrouping()
        XCTAssertNil(model.error)
        XCTAssertNil(model.audioTranscript)
        let reading = try XCTUnwrap(model.file?.readings.first)
        XCTAssertEqual(reading.text, review.text)
        let anchor = try XCTUnwrap(model.file?.anchors.first { $0.id == reading.anchorId })
        XCTAssertEqual(anchor.region.startMs, 400); XCTAssertEqual(anchor.region.endMs, 800)
        XCTAssertEqual(anchor.sourceHash, hash)
        let reopened = try RecastPackage.decode(RecastPackage.encode(XCTUnwrap(model.state)))
        XCTAssertEqual(reopened.assets, initial.assets)
        XCTAssertEqual(reopened.file.readings.first?.text, review.text)
        let restored = expectation(description: "Transcript capture undone")
        model.onReady = { if !model.busy && model.file?.readings.isEmpty == true { model.onReady = nil; restored.fulfill() } }
        undo.undo()
        await fulfillment(of: [restored], timeout: 15)
        XCTAssertEqual(model.file?.revision, file.revision)
        model.saveAudioTranscript(review, mode: "readings")
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.error, "The conversion changed. Transcribe this interval again before saving readings.")
        XCTAssertEqual(model.assets, initial.assets)
    }
}

extension RecastTests {
    func testProcessFailureExplainsRecoveryWithoutShowingCrashDumpAndPreservesValidationErrors() {
        let crash = ToolsRunResult(stdout: "", stderr: "panic: A C++ exception occurred\nBun has crashed\n/private/fixture/runtime.cpp", exitCode: 6, wallMs: 10)
        let message = recastCommandError("transcribe", result: crash).localizedDescription
        XCTAssertTrue(message.contains("Transcription stopped unexpectedly"))
        XCTAssertTrue(message.contains("original sources and saved edits are preserved"))
        XCTAssertTrue(message.contains("spoken language"))
        XCTAssertFalse(message.contains("runtime.cpp"))
        XCTAssertFalse(message.contains("panic:"))
        let validation = ToolsRunResult(stdout: #"{"error":"Choose a positive interval within the recording."}"#,
            stderr: "", exitCode: 1, wallMs: 10)
        XCTAssertEqual(recastCommandError("transcribe", result: validation).localizedDescription,
            "Choose a positive interval within the recording.")
        let rejected = ToolsRunResult(stdout: "", stderr: "The selected model is unavailable.", exitCode: 1, wallMs: 10)
        XCTAssertEqual(recastCommandError("propose", result: rejected).localizedDescription,
            "The selected model is unavailable.")
        let terminated = ToolsRunResult(stdout: "", stderr: "", exitCode: 137, wallMs: 10)
        XCTAssertTrue(recastCommandError("inspect", result: terminated).localizedDescription.contains("Recast stopped unexpectedly"))
    }
}
