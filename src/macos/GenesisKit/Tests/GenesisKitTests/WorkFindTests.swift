import AppKit
import SwiftUI
import Vision
import Foundation
import XCTest
@testable import GenesisKit

/// Invented project data shared by the matcher tests and the later Items pane rendering tests.
enum WorkFindFixture {
    static let project = "Orchard"
    static let basketRef = "h_orchard1"
    static let basketTaskRef = "h_orchard1:t2"

    static var snapshot: WorkSnapshotValue {
        WorkSnapshotValue(project: project, containers: [
            WorkContainerValue(ref: basketRef, type: "handoff", state: "active", title: "Prepare the autumn release",
                               open: 3, total: 4, members: [
                                   WorkRowValue(ref: "h_orchard1:t1", state: "open", type: "task", title: "Read the release checklist", slot: "t1"),
                                   WorkRowValue(ref: basketTaskRef, state: "active", type: "task", worker: "codex abcd1234",
                                                title: "Keep a basket after checkout", slot: "t2"),
                                   WorkRowValue(ref: "h_orchard1:t3", state: "reopened", type: "test", title: "Repeat the receipt check", slot: "t3"),
                                   WorkRowValue(ref: "h_orchard1:t4", state: "done", type: "task", title: "Write release notes", slot: "t4"),
                               ]),
            WorkContainerValue(ref: "h_orchard2", type: "handoff", state: "open", title: "Improve account settings",
                               open: 1, total: 1, members: [
                                   WorkRowValue(ref: "h_orchard2:t1", state: "open", type: "task", title: "Explain profile visibility", slot: "t1"),
                               ]),
            WorkContainerValue(ref: "w_orchard3", type: "epic", state: "open", title: "Make delivery times clear",
                               open: 1, total: 1, members: [
                                   WorkRowValue(ref: "w_orchard4", state: "open", type: "feature", title: "Show the next delivery window"),
                               ]),
        ], triage: spotted + reopened)
    }

    static var spotted: [WorkTriageValue] {
        (0..<10).map { number in
            let type = ["bug", "idea", "task"][number % 3]
            return WorkTriageValue(ref: "w_spotted\(number)", group: "spotted", type: type, state: "spotted",
                                   title: number == 0 ? "The widget inbox overview shows blurred images" : "Review orchard item \(number)",
                                   where: "src/fixture/view\(number).ts:\(number + 1)",
                                   why: number == 0 ? "The thumbnail cache keeps an older size" : "A fixture observation",
                                   userSees: number == 0 ? "Small pictures look fuzzy" : nil,
                                   severity: number % 2 == 0 ? "high" : nil)
        }
    }

    static var reopened: [WorkTriageValue] {
        [
            WorkTriageValue(ref: "w_reopened1", group: "reopened-no-worker", type: "bug", state: "reopened",
                            title: "Restore the delivery reminder", severity: "medium"),
            WorkTriageValue(ref: "w_reopened2", group: "reopened-no-worker", type: "test", state: "reopened",
                            title: "Check the empty receipt again"),
        ]
    }

    static var index: [WorkRowValue] {
        [
            WorkRowValue(ref: "w_finished1", state: "done", type: "bug", severity: "high", title: "Repair archived invoice images", project: project),
            WorkRowValue(ref: "w_dropped01", state: "dropped", type: "idea", title: "Add a seasonal greeting", project: project),
            WorkRowValue(ref: "h_orchard1:t4", state: "done", type: "task", title: "Write release notes", project: project, slot: "t4"),
        ]
    }

    // The work.show reply shape: worker and actor are stamps; refs have out/in arrays; events carry payloads.
    // Values and identities are invented. Collection order follows the service reply.
    static let detailJSON = #"""
    {
      "item": {
        "id": "w_fixture01", "title": "Keep receipt images readable", "type": "bug", "state": "done",
        "project": "Orchard", "body": "## Receipt images\nKeep the original image size.",
        "acceptance": "A downloaded receipt stays readable.", "severity": "high", "tags": ["receipt", "images"], "rev": 7,
        "worker": {"kind":"agent","harness":"codex","sessionId":"abcd1234-fixture","sessionTitle":"Receipt repair",
                   "model":null,"host":null},
        "fields": {"where":"src/fixture/receipt.ts:42","why":"The preview replaces the original",
                   "userSees":"Text becomes blurred","production":true,"cost":4,"optional":null,
                   "measured":{"height":80,"width":120},"remind":[{"at":"2026-12-01T09:00:00Z","label":"Check again"}]}
      },
      "members": [{"ref":"w_child0001","state":"open","type":"task","title":"Check receipt export","slot":"t1"}],
      "refs": {
        "out": [{"from":"w_fixture01","kind":"spotted-in","to":"h_orchard1",
                 "by":{"kind":"agent","harness":"codex","sessionTitle":"Receipt repair"},"ts":"2026-11-19T10:00:00.000Z"}],
        "in": [{"from":"w_blocker01","kind":"blocks","to":"w_fixture01",
                "by":{"kind":"owner","harness":"cli","sessionTitle":null},"ts":"2026-11-19T10:00:00Z"}]
      },
      "pointers": [{"kind":"commit","target":"abc1234"},{"kind":"file","target":"src/fixture/receipt.ts:42"},
                   {"kind":"pr","target":"example/project#12"},{"kind":"url","target":"https://example.com/receipt"},
                   {"kind":"future-kind","target":"opaque-fixture"}],
      "log": [
        {"seq":7,"v":1,"ts":"2026-11-19T10:07:00.000Z","item":"w_fixture01",
         "actor":{"kind":"owner","harness":"cli","sessionTitle":null},"kind":"moved",
         "payload":{"from":"active","to":"done","proof":{"text":"The export check passed."}},"origin":{"via":"local"}},
        {"seq":6,"v":1,"ts":"2026-11-19T10:06:00Z","item":"w_fixture01",
         "actor":{"kind":"agent","harness":"codex","sessionTitle":"Receipt repair"},"kind":"commented",
         "payload":{"text":"The original size is preserved."},"origin":{"via":"local"}},
        {"seq":5,"v":1,"ts":"2026-11-19T10:05:00.000Z","item":"w_fixture01",
         "actor":{"kind":"agent","harness":"codex","sessionTitle":null},"kind":"logged",
         "payload":{"result":"failed","note":"The first resize still blurred text."},"origin":{"via":"local"}},
        {"seq":4,"v":1,"ts":"2026-11-19T10:04:00Z","item":"w_fixture01",
         "actor":{"kind":"agent","harness":"codex","sessionTitle":"Receipt repair"},"kind":"pointed",
         "payload":{"pointer":{"kind":"commit","target":"abc1234"}},"origin":{"via":"local"}}
      ]
    }
    """#

    static func detail() throws -> WorkItemDetail {
        try JSONDecoder().decode(WorkItemDetail.self, from: Data(detailJSON.utf8))
    }
}

@MainActor
private final class WorkFindSource: WorkSource {
    var itemProject = WorkFindFixture.project
    var writeOutcome: WorkActionOutcome?
    var listedProjects: [String] = []
    var detailRefs: [String] = []
    var delayedRef: String?
    var delayedDetail: CheckedContinuation<WorkItemDetail, Never>?
    var delayedReturned = false
    private var changesContinuation: AsyncStream<Void>.Continuation?

    func projects() async throws -> [String] { [WorkFindFixture.project, "Meadow"] }
    func snapshot(project: String) async throws -> WorkSnapshotValue {
        var value = WorkFindFixture.snapshot
        value.project = project
        return value
    }
    func list(project: String) async throws -> [WorkRowValue] {
        listedProjects.append(project)
        return WorkFindFixture.index.map { row in
            var value = row
            value.project = project
            return value
        }
    }
    func detail(ref: String) async throws -> WorkItemDetail {
        detailRefs.append(ref)
        if ref == delayedRef {
            let value = await withCheckedContinuation { delayedDetail = $0 }
            delayedReturned = true
            return value
        }
        return detailValue(ref: ref)
    }
    func detailValue(ref: String) -> WorkItemDetail {
        let state = WorkFindFixture.index.first { $0.ref == ref }?.state ?? "open"
        return WorkItemDetail(item: .init(id: ref, title: "Fixture \(ref)", type: "task", state: state, project: itemProject))
    }
    func notify(project: String) async throws -> [WorkNotifyRow] { [] }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        writeOutcome ?? WorkActionOutcome(ok: true, message: action.done)
    }
    func changes() -> AsyncStream<Void> { AsyncStream { changesContinuation = $0 } }
    func tick() { changesContinuation?.yield(()) }
    func finishDelayed() {
        guard let ref = delayedRef else { return }
        delayedDetail?.resume(returning: detailValue(ref: ref))
        delayedDetail = nil
    }
}

final class WorkFindTests: XCTestCase {
    func testTheShowReplyDecodesEveryDetailFieldReferencePointerAndEvent() throws {
        let detail = try WorkFindFixture.detail()
        XCTAssertEqual(detail.item.id, "w_fixture01")
        XCTAssertEqual(detail.item.title, "Keep receipt images readable")
        XCTAssertEqual(detail.item.type, "bug")
        XCTAssertEqual(detail.item.state, "done")
        XCTAssertEqual(detail.item.project, "Orchard")
        XCTAssertEqual(detail.item.body, "## Receipt images\nKeep the original image size.")
        XCTAssertEqual(detail.item.acceptance, "A downloaded receipt stays readable.")
        XCTAssertEqual(detail.item.severity, "high")
        XCTAssertEqual(detail.item.worker, "Receipt repair")
        XCTAssertEqual(detail.item.tags, ["receipt", "images"])
        XCTAssertEqual(detail.item.rev, 7)
        let fields = try XCTUnwrap(detail.item.fields)
        XCTAssertEqual(fields["where"], "src/fixture/receipt.ts:42")
        XCTAssertEqual(fields["why"], "The preview replaces the original")
        XCTAssertEqual(fields["userSees"], "Text becomes blurred")
        XCTAssertEqual(fields["production"], "true")
        XCTAssertEqual(fields["cost"], "4")
        XCTAssertEqual(fields["optional"], "null")
        XCTAssertEqual(fields["measured"], #"{"height":80,"width":120}"#)
        XCTAssertEqual(fields["remind"], #"[{"at":"2026-12-01T09:00:00Z","label":"Check again"}]"#)
        XCTAssertEqual(detail.members?.map(\.ref), ["w_child0001"])
        XCTAssertEqual(detail.members?.first?.slot, "t1")

        XCTAssertEqual(detail.refs.count, 2)
        let outgoing = try XCTUnwrap(detail.refs.first)
        XCTAssertEqual(outgoing.kind, "spotted-in")
        XCTAssertEqual(outgoing.other, "h_orchard1")
        XCTAssertTrue(outgoing.outgoing)
        XCTAssertEqual(outgoing.byTitle, "Receipt repair")
        XCTAssertEqual(outgoing.id, "out:spotted-in:h_orchard1")
        let incoming = detail.refs[1]
        XCTAssertEqual(incoming.kind, "blocks")
        XCTAssertEqual(incoming.other, "w_blocker01")
        XCTAssertFalse(incoming.outgoing)
        XCTAssertNil(incoming.byTitle)
        XCTAssertEqual(incoming.id, "in:blocks:w_blocker01")

        XCTAssertEqual(detail.pointers.map(\.kind), ["commit", "file", "pr", "url", "future-kind"])
        XCTAssertEqual(detail.pointers.map(\.target), ["abc1234", "src/fixture/receipt.ts:42", "example/project#12",
                                                     "https://example.com/receipt", "opaque-fixture"])
        XCTAssertEqual(detail.pointers.last?.id, "future-kind:opaque-fixture")
        XCTAssertEqual(detail.log.map(\.seq), [7, 6, 5, 4])
        XCTAssertEqual(detail.log.map(\.kind), ["moved", "commented", "logged", "pointed"])
        XCTAssertEqual(detail.log.map(\.actor), ["you", "Receipt repair", "codex", "Receipt repair"])
        XCTAssertEqual(detail.log.map(\.summary), ["The export check passed.", "The original size is preserved.",
                                                 "The first resize still blurred text.", nil])
        let finished = try XCTUnwrap(detail.log.first)
        XCTAssertEqual(finished.action, "finished it")
        XCTAssertEqual(finished.id, 7)
        XCTAssertEqual(detail.log[1].ts.timeIntervalSince(finished.ts), -60, accuracy: 0.001)
    }

    func testAnOlderReplyWithoutDetailCollectionsStillDecodes() throws {
        let bytes = Data(#"{"item":{"id":"t_fixture01","title":"Review a question","type":"task","state":"open"}}"#.utf8)
        let detail = try JSONDecoder().decode(WorkItemDetail.self, from: bytes)
        XCTAssertEqual(detail.item.id, "t_fixture01")
        XCTAssertNil(detail.item.project)
        XCTAssertNil(detail.item.fields)
        XCTAssertNil(detail.members)
        XCTAssertEqual(detail.refs, [])
        XCTAssertEqual(detail.pointers, [])
        XCTAssertEqual(detail.log, [])
    }

    func testEverySearchWordMustMatchAWordPrefix() {
        let images = WorkFilter.Row(ref: "w_images001", title: "The widget inbox overview shows blurred images", type: "bug", state: "spotted")
        let count = WorkFilter.Row(ref: "w_count0001", title: "Inbox count", type: "bug", state: "spotted")
        XCTAssertTrue(WorkFilter(text: "inbox imag").matches(images))
        XCTAssertFalse(WorkFilter(text: "inbox imag").matches(count))
        XCTAssertFalse(WorkFilter(text: "box").matches(count), "a suffix is not a word prefix")
        XCTAssertTrue(WorkFilter(text: "INBOX, IMÁG").matches(images))
    }

    func testSearchIncludesRefTypeWorkerAndAdditionalFields() {
        let row = WorkFilter.Row(ref: "h_fixture01:t2", title: "Preserve the original", type: "cleanup", state: "active",
                                 worker: "codex abcd1234", text: ["src/fixture/receipt.ts:42", "Café preview", "t2"])
        for query in ["h_fixture01:t2", "clean", "abcd", "receipt", "CAFE", "t2", "pres orig"] {
            XCTAssertTrue(WorkFilter(text: query).matches(row), "missing search field for \(query)")
        }
        XCTAssertFalse(WorkFilter(text: "receipt missing").matches(row))
    }

    func testTheDefaultFilterKeepsTheExistingOpenSpottedAndReopenedRows() {
        XCTAssertFalse(WorkFilter.default.isActive)
        XCTAssertEqual(WorkFilter.default.states, [.open, .spotted, .reopened])
        for state in ["open", "active", "spotted", "reopened", "done", "dropped"] {
            let row = WorkFilter.Row(ref: "w_state0001", title: "State fixture", type: "task", state: state)
            XCTAssertEqual(WorkFilter.default.matches(row), ["open", "active", "spotted", "reopened"].contains(state), state)
        }
        let snapshot = WorkFindFixture.snapshot
        let visible = WorkItemsProjection(snapshot: snapshot).visibleRefs
        let expected = snapshot.containers.map(\.ref) + snapshot.containers.flatMap(\.members).map(\.ref)
            + snapshot.spotted.map(\.ref) + snapshot.reopened.map(\.ref)
        let expanded = WorkItemsProjection(snapshot: snapshot, expanded: Set(snapshot.containers.map(\.ref)))
        XCTAssertEqual(Set(expanded.visibleRefs), Set(expected))
        XCTAssertFalse(visible.contains("h_orchard1:t4"))
        XCTAssertEqual(expanded.archive, [])
    }

    func testDoneAloneOnlyShowsDoneRows() {
        let filter = WorkFilter(states: [.done])
        XCTAssertTrue(filter.isActive)
        for state in ["open", "active", "spotted", "reopened", "done", "dropped"] {
            let row = WorkFilter.Row(ref: "w_state0001", title: "State fixture", type: "task", state: state)
            XCTAssertEqual(filter.matches(row), state == "done", state)
        }
        let result = WorkItemsProjection(snapshot: WorkFindFixture.snapshot, filter: filter, index: WorkFindFixture.index)
        XCTAssertEqual(Set(result.archive.map(\.ref)), ["w_finished1", "h_orchard1:t4"])
        XCTAssertEqual(result.containers.count, 0)
        XCTAssertEqual(result.reopened.count, 0)
        XCTAssertEqual(result.spottedGroups.count, 0)
    }

    func testFacetsCombineAndMineExcludesAnAgentClaim() {
        let row = WorkFilter.Row(ref: "w_facets001", title: "Repair the export", type: "bug", state: "open", severity: "high")
        XCTAssertTrue(WorkFilter(types: ["bug"], severities: ["high"], mine: true).matches(row))
        XCTAssertFalse(WorkFilter(types: ["task"]).matches(row))
        XCTAssertFalse(WorkFilter(severities: ["low"]).matches(row))
        var claimed = row
        claimed.worker = "codex abcd1234"
        XCTAssertFalse(WorkFilter(mine: true).matches(claimed))
        XCTAssertTrue(WorkFilter.default.matches(claimed))
        for worker in ["hub ?", "unknown ?", "human ?"] {
            claimed.worker = worker
            XCTAssertTrue(WorkFilter(mine: true).matches(claimed), worker)
        }
        claimed.worker = "hub abcd1234"
        XCTAssertFalse(WorkFilter(mine: true).matches(claimed))
    }

    func testMineUsesKnownOwnershipAndAHiddenTriageRowsFieldsRemainSearchable() {
        let container = WorkContainerValue(ref: "h_orchard1", type: "handoff", state: "active",
                                           title: "Check the checkout", open: 0, total: 0, members: [])
        let triage = WorkTriageValue(ref: "w_stalled1", group: "active-worker-gone", type: "task",
                                    state: "active", title: "Review the receipt", why: "The thumbnail expired")
        let snapshot = WorkSnapshotValue(project: "Orchard", containers: [container], triage: [triage])
        var indexedContainer = WorkRowValue(ref: container.ref, state: container.state, type: container.type,
                                           worker: "helper ab123456", title: container.title)
        let mine = WorkFilter(mine: true)
        XCTAssertTrue(WorkItemsProjection(snapshot: snapshot, filter: mine).containers.isEmpty)
        XCTAssertTrue(WorkItemsProjection(snapshot: snapshot, filter: mine, index: [indexedContainer]).containers.isEmpty)
        indexedContainer.worker = "hub ?"
        XCTAssertEqual(WorkItemsProjection(snapshot: snapshot, filter: mine, index: [indexedContainer]).containers.map(\.ref), [container.ref])
        let row = WorkRowValue(ref: triage.ref, state: triage.state, type: triage.type, title: triage.title)
        XCTAssertEqual(WorkItemsProjection(snapshot: snapshot, filter: .init(text: "thumbnail"), index: [row]).other, [row])
    }

    @MainActor
    func testFailedSavesAndLaterEditsKeepTheirOwnDraft() async throws {
        let drafts = WorkItemInspectorDrafts()
        let key = WorkItemInspectorDrafts.Key(ref: "w_receipt1", purpose: "finish")
        let text = drafts.binding(key)
        text.wrappedValue = "Archive read back"
        let saving = try XCTUnwrap(drafts.submit(key) { submitted in
            XCTAssertEqual(submitted, "Archive read back")
            return true
        })
        XCTAssertNil(drafts.submit(key) { _ in XCTFail("Duplicate write"); return true })
        text.wrappedValue = "Second proof"
        _ = await saving.value
        XCTAssertEqual(text.wrappedValue, "Second proof")
        let failed = try XCTUnwrap(drafts.submit(key) { _ in false })
        let ok = await failed.value
        XCTAssertFalse(ok)
        XCTAssertEqual(text.wrappedValue, "Second proof")
        let retried = try XCTUnwrap(drafts.submit(key) { _ in true })
        _ = await retried.value
        XCTAssertEqual(text.wrappedValue, "")
    }

    func testAFullRefRanksBeforeAnIncidentalTextMatch() {
        let exact = WorkFilter.Row(ref: "w_target01", title: "Receipt repair", type: "bug", state: "spotted")
        let incidental = WorkFilter.Row(ref: "w_other001", title: "Recheck w_target01 after export", type: "task", state: "spotted")
        let filter = WorkFilter(text: "w_target01")
        XCTAssertTrue(filter.matches(exact))
        XCTAssertTrue(filter.matches(incidental))
        XCTAssertLessThan(filter.rank(exact), filter.rank(incidental))
        let snapshot = WorkSnapshotValue(project: "Orchard", containers: [], triage: [
            WorkTriageValue(ref: incidental.ref, group: "spotted", type: "task", state: "spotted", title: incidental.title),
            WorkTriageValue(ref: exact.ref, group: "spotted", type: "bug", state: "spotted", title: exact.title),
        ])
        XCTAssertEqual(WorkItemsProjection(snapshot: snapshot, filter: filter).visibleRefs.first, exact.ref)
        let archiveHit = WorkRowValue(ref: exact.ref, state: "done", type: "bug", title: exact.title)
        let onlyMention = WorkSnapshotValue(project: "Orchard", containers: [], triage: [snapshot.triage[0]])
        let acrossSections = WorkItemsProjection(snapshot: onlyMention, filter: filter, index: [archiveHit])
        XCTAssertEqual(acrossSections.visibleRefs, [exact.ref])
        XCTAssertEqual(acrossSections.archive.map(\.ref), [exact.ref])
    }

    func testTextSearchIncludesArchivedRowsWithoutShowingUnrelatedArchive() {
        let result = WorkItemsProjection(snapshot: WorkFindFixture.snapshot, filter: WorkFilter(text: "invoice imag"),
                                         index: WorkFindFixture.index)
        XCTAssertEqual(result.archive.map(\.ref), ["w_finished1"])
        XCTAssertTrue(WorkFilter(text: "invoice").requiresIndex)
        XCTAssertTrue(WorkFilter(states: [.dropped]).requiresIndex)
        XCTAssertFalse(WorkFilter.default.requiresIndex)
    }

    @MainActor
    private func settle(file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), "the fixture load did not settle", file: file, line: line)
    }

    @MainActor
    func testTheModelReadsTheIndexOnDemandCachesDetailsAndRejectsAnOlderSelection() async {
        let source = WorkFindSource()
        let model = WorkScreenModel(source: source, reloadInterval: 0.02, settle: 0.01)
        model.activate()
        defer { source.finishDelayed(); model.deactivate() }
        await settle { model.snapshot != nil && !model.isLoading }
        XCTAssertEqual(source.listedProjects, [], "the default pane needs only tree and triage")

        model.filter = WorkFilter(text: "invoice")
        await settle { !model.indexLoading && !model.index.isEmpty }
        XCTAssertEqual(source.listedProjects, ["Orchard"])
        model.filter = WorkFilter(text: "images")
        model.loadIndexIfNeeded()
        XCTAssertEqual(source.listedProjects, ["Orchard"], "another query reuses the project index")

        source.tick()
        await settle { source.listedProjects.count == 2 && !model.indexLoading }
        XCTAssertEqual(source.listedProjects, ["Orchard", "Orchard"], "a store change invalidates the index")
        model.project = "Meadow"
        await settle { model.snapshot?.project == "Meadow" && !model.isLoading }
        XCTAssertEqual(model.filter, .default)
        XCTAssertEqual(model.index, [])
        XCTAssertEqual(source.listedProjects.count, 2)
        model.filter = WorkFilter(states: [.done])
        await settle { source.listedProjects.last == "Meadow" && !model.indexLoading }
        XCTAssertTrue(model.index.allSatisfy { $0.project == "Meadow" })

        model.project = WorkFindFixture.project
        await settle { model.snapshot?.project == WorkFindFixture.project && !model.isLoading }
        model.select("w_cached01")
        await settle { model.itemDetail?.item.id == "w_cached01" && !model.isLoading }
        model.select("w_cached02")
        await settle { model.itemDetail?.item.id == "w_cached02" && !model.isLoading }
        model.select("w_cached01")
        XCTAssertEqual(model.itemDetail?.item.id, "w_cached01", "a cached detail is available in the selection frame")
        XCTAssertEqual(source.detailRefs.filter { $0 == "w_cached01" }.count, 1)
        source.tick()
        await settle { source.detailRefs.filter { $0 == "w_cached01" }.count == 2 && !model.isLoading }

        source.delayedRef = "w_slow0001"
        model.select("w_slow0001")
        await settle { source.delayedDetail != nil }
        model.select("w_latest01")
        await settle { model.itemDetail?.item.id == "w_latest01" && !model.isLoading }
        source.finishDelayed()
        await settle { source.delayedReturned }
        XCTAssertEqual(model.selection, "w_latest01")
        XCTAssertEqual(model.itemDetail?.item.id, "w_latest01", "an earlier reply cannot replace the current selection")
    }

    func testFilterFiveThousandRowsPerformance() {
        let rows = (0..<5_000).map { number in
            WorkFilter.Row(ref: "w_perf\(number)", title: number.isMultiple(of: 10) ? "Inbox images need a preview" : "Inbox count needs a label",
                           type: "task", state: "open", text: ["src/fixture/view\(number).ts", "A generated observation"])
        }
        let filter = WorkFilter(text: "inbox imag")
        var matched = 0
        measure { matched = rows.filter { filter.matches($0) }.count }
        XCTAssertEqual(matched, 500)
    }

    @MainActor
    func testTheInspectorKeepsAMovedItemUntilTheReaderFollowsIt() async {
        let source = WorkFindSource()
        let model = WorkScreenModel(source: source, reloadInterval: 0.02, settle: 0.01)
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        let ref = WorkFindFixture.basketTaskRef
        model.select(ref)
        await settle { model.itemDetail?.item.id == ref }
        source.itemProject = "Meadow"
        source.tick()
        await settle { model.movedFrom == WorkFindFixture.project && model.itemDetail?.item.project == "Meadow" }
        XCTAssertEqual(model.project, WorkFindFixture.project)
        model.openMovedItem()
        await settle { model.project == "Meadow" && model.snapshot?.project == "Meadow" && !model.isLoading }
        XCTAssertEqual(model.selection, ref)
        XCTAssertNil(model.movedFrom)
        source.writeOutcome = .init(ok: false, message: "Could not save this comment")
        let saved = await model.write(.comment(ref: ref, text: "Keep the draft for retry"))
        XCTAssertFalse(saved)
        XCTAssertEqual(model.notice, source.writeOutcome)
        XCTAssertEqual(model.itemDetail?.item.id, ref)
        XCTAssertTrue(model.pending.isEmpty)
    }

    @MainActor
    func testReturningToWorkRefreshesTheSelectedItemAfterTimeAway() async {
        let source = WorkFindSource()
        let screen = WorkScreenModel(source: source)
        screen.activate()
        defer { screen.deactivate() }
        await settle { screen.snapshot != nil }
        screen.select(WorkFindFixture.basketTaskRef)
        await settle { screen.itemDetail != nil && !screen.isLoading }
        screen.deactivate()
        screen.activate()
        await settle { source.detailRefs.count == 2 && !screen.isLoading }
        XCTAssertEqual(screen.selection, WorkFindFixture.basketTaskRef)
    }
}

@MainActor
private final class WorkFindRenderInput {
    let snapshot: WorkSnapshotValue
    let index: [WorkRowValue]
    var filter: WorkFilter = .default
    var expanded: Set<String> = []
    var collapsed: Set<String> = []

    init(snapshot: WorkSnapshotValue = WorkFindFixture.snapshot,
         index: [WorkRowValue] = WorkFindFixture.index) {
        self.snapshot = snapshot
        self.index = index
    }

    func change(_ value: WorkFilter) {
        if filter != value { collapsed = [] }
        filter = value
    }

    func clear() { change(.default) }

    var projection: WorkItemsProjection {
        WorkItemsProjection(snapshot: snapshot, filter: filter, index: index,
                            expanded: expanded, collapsed: collapsed)
    }

    var view: some View {
        let projected = projection
        return VStack(alignment: .leading, spacing: 0) {
            WorkFindBar(filter: Binding(get: { self.filter }, set: { self.change($0) }),
                        matchedCount: projected.matchedCount, totalCount: projected.totalCount,
                        onClear: clear, onSubmit: {})
            Divider()
            WorkItemsView(snapshot: snapshot, projection: projected, filter: filter,
                          selection: nil, pending: [], indexLoading: false, indexFailure: nil,
                          select: { _ in }, toggleExpansion: { ref, opens in
                              if opens {
                                  self.expanded.insert(ref)
                                  self.collapsed.remove(ref)
                              } else {
                                  self.expanded.remove(ref)
                                  self.collapsed.insert(ref)
                              }
                          }, showMore: {}, clearFilters: clear, retryIndex: {}, perform: { _ in true })
                .padding(12)
            Spacer(minLength: 0)
        }
        .background(Color.black)
        .environment(\.colorScheme, .dark)
    }
}

@MainActor
extension WorkFindTests {
    func testFindRendersTheFixtureBasketDoneAndClearRestoresTheFirstText() throws {
        let input = WorkFindRenderInput()
        let size = CGSize(width: 1000, height: 1500)
        let (window, rawHost) = HostedShot.host(input.view, size: size)
        defer { window.close() }
        let host = try XCTUnwrap(rawHost as? NSHostingView<AnyView>)

        func draw(_ name: String? = nil) throws -> String {
            host.rootView = AnyView(input.view.frame(width: size.width, height: size.height, alignment: .topLeading))
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            let bitmap = try XCTUnwrap(HostedShot.bitmap(host))
            let image = try XCTUnwrap(bitmap.cgImage)
            if let name, let folder = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                let directory = URL(fileURLWithPath: folder, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: directory.appendingPathComponent(name + ".png"))
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try readWorkScreenshot(image, with: request)
            let lines = (request.results ?? []).compactMap { result in
                result.topCandidates(1).first.map { (text: $0.string, y: result.boundingBox.midY, x: result.boundingBox.minX) }
            }.sorted { left, right in
                if abs(left.y - right.y) > 0.004 { return left.y > right.y }
                return left.x < right.x
            }.map(\.text)
            XCTAssertFalse(lines.isEmpty, "The offscreen capture must contain readable text")
            return lines.joined(separator: "\n")
        }

        let first = try draw("work-find-before")
        for expected in ["Find items by words or ref", "Prepare the autumn release", "Improve account settings",
                         "Make delivery times clear", "Spotted", "Review orchard item 9",
                         "Restore the delivery reminder", "Check the empty receipt again"] {
            XCTAssertTrue(first.contains(expected), "Missing \(expected) in:\n\(first)")
        }
        XCTAssertFalse(first.contains("Clear filters"), first)
        XCTAssertFalse(first.contains("Done and dropped"), first)

        func editableField(in view: NSView) -> NSTextField? {
            if let field = view as? NSTextField, field.isEditable { return field }
            return view.subviews.lazy.compactMap { editableField(in: $0) }.first
        }
        let field = try XCTUnwrap(editableField(in: host))
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.insertText("basket", replacementRange: editor.selectedRange())
        _ = window.makeFirstResponder(nil)
        let typed = Date().addingTimeInterval(2)
        while input.filter.text != "basket" && Date() < typed {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        XCTAssertEqual(input.filter.text, "basket")
        let basket = try draw("work-find-after")
        for expected in ["basket", "Keep a basket after checkout", "1 of 4 tasks match",
                         "No match in Spotted", "No match in Reopened", "Clear filters"] {
            XCTAssertTrue(basket.contains(expected), "Missing \(expected) in:\n\(basket)")
        }
        for hidden in ["Improve account settings", "Make delivery times clear", "Read the release checklist",
                       "Review orchard item 9", "Restore the delivery reminder", "Repair archived invoice images"] {
            XCTAssertFalse(basket.contains(hidden), "Unexpected \(hidden) in:\n\(basket)")
        }
        XCTAssertEqual(input.projection.containers.map(\.ref), [WorkFindFixture.basketRef])
        XCTAssertTrue(try XCTUnwrap(input.projection.containers.first).isExpanded)

        input.change(WorkFilter(states: [.done]))
        let done = try draw()
        for expected in ["State: Done", "Done and dropped", "Repair archived invoice images", "Write release notes"] {
            XCTAssertTrue(done.contains(expected), "Missing \(expected) in:\n\(done)")
        }
        for hidden in ["Handoffs and epics", "Spotted", "Reopened, nobody working", "Prepare the autumn release",
                       "Keep a basket after checkout", "Add a seasonal greeting", "Review orchard item 9"] {
            XCTAssertFalse(done.contains(hidden), "Unexpected \(hidden) in:\n\(done)")
        }

        // This is the same callback passed to the production bar and the list's Clear filters button.
        input.clear()
        let restored = try draw()
        XCTAssertEqual(restored, first, "Clearing every facet restores the first rendering's complete drawn text")
    }

    func testOneFilterChangeAndRenderWithOneHundredOpenRowsPerformance() throws {
        let rows = (0..<100).map { number in
            WorkRowValue(ref: "h_render01:t\(number)", state: "open", type: "task",
                         title: number.isMultiple(of: 2) ? "Keep basket item \(number)" : "Read receipt item \(number)",
                         slot: "t\(number)")
        }
        let snapshot = WorkSnapshotValue(project: WorkFindFixture.project, containers: [
            WorkContainerValue(ref: "h_render01", type: "handoff", state: "open", title: "Prepare the fixture release",
                               open: 100, total: 100, members: rows),
        ], triage: [])
        let input = WorkFindRenderInput(snapshot: snapshot, index: [])
        input.expanded = ["h_render01"]
        let size = CGSize(width: 1000, height: 900)
        let (window, rawHost) = HostedShot.host(input.view, size: size)
        defer { window.close() }
        let host = try XCTUnwrap(rawHost as? NSHostingView<AnyView>)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        _ = try XCTUnwrap(HostedShot.bitmap(host))
        var iteration = 0
        var lastImage: CGImage?
        var renderFailure: Error?

        // XCTest reports wall time for a changed query, projection, view update, layout and drawing.
        // OCR, file output, host construction and fixed settling waits are outside the measured block.
        // Compare the reported mean with P2's 16 ms target and 50 ms debounce decision threshold.
        measure {
            iteration += 1
            input.change(WorkFilter(text: iteration.isMultiple(of: 2) ? "basket" : "receipt"))
            host.rootView = AnyView(input.view.frame(width: size.width, height: size.height, alignment: .topLeading))
            host.layoutSubtreeIfNeeded()
            do {
                let bitmap = try XCTUnwrap(HostedShot.bitmap(host))
                lastImage = try XCTUnwrap(bitmap.cgImage)
            } catch { renderFailure = error }
        }
        XCTAssertNil(renderFailure)
        let image = try XCTUnwrap(lastImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try readWorkScreenshot(image, with: request)
        let drawn = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        let expected = iteration.isMultiple(of: 2) ? "Keep basket item" : "Read receipt item"
        let hidden = iteration.isMultiple(of: 2) ? "Read receipt item" : "Keep basket item"
        XCTAssertTrue(drawn.contains(expected), drawn)
        XCTAssertFalse(drawn.contains(hidden), drawn)
        XCTAssertEqual(input.projection.containers.first?.matchingCount, 50)
    }
}

/// Vision's accurate recognizer can fail to initialize its E5RT model on a busy Mac. Read the same
/// rendered pixels with its CPU recognizer in that case. Every visible-word assertion still runs.
func readWorkScreenshot(_ image: CGImage, with request: VNRecognizeTextRequest) throws {
    do {
        try VNImageRequestHandler(cgImage: image).perform([request])
    } catch {
        request.recognitionLevel = .fast
        for (stage, devices) in try request.supportedComputeStageDevices {
            if let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) {
                request.setComputeDevice(cpu, for: stage)
            }
        }
        try VNImageRequestHandler(cgImage: image).perform([request])
    }
}

@MainActor
extension WorkFindTests {
    func testArrowSelectionTraversesOnlyMatchingVisibleRowsAndStopsAtTheEnds() async {
        let model = WorkScreenModel(source: WorkFindSource())
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        model.filter.text = "basket"
        let rows = [WorkFindFixture.basketRef, WorkFindFixture.basketTaskRef]
        XCTAssertEqual(model.visibleRefs, rows)
        model.moveSelection(1)
        XCTAssertEqual(model.selection, rows.first)
        model.moveSelection(-1)
        XCTAssertEqual(model.selection, rows.first)
        model.moveSelection(1)
        XCTAssertEqual(model.selection, rows.last)
        model.moveSelection(1)
        XCTAssertEqual(model.selection, rows.last)
        model.moveSelection(-1)
        XCTAssertEqual(model.selection, rows.first)
        model.toggleContainer(WorkFindFixture.basketRef)
        XCTAssertEqual(model.visibleRefs, [WorkFindFixture.basketRef])
    }

    func testAWorkRouteRevealsTheItemAndExplainsAReset() async {
        let model = WorkScreenModel(source: WorkFindSource())
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        model.filter = WorkFilter(text: "unrelated", types: ["feature"], mine: true)
        await settle { !model.indexLoading }
        model.openItem(WorkFindFixture.basketTaskRef)
        await settle { model.visibleRefs.contains(WorkFindFixture.basketTaskRef) }
        XCTAssertEqual(model.filter, .default)
        XCTAssertEqual(model.filterNotice, "Filter cleared to show " + WorkFindFixture.basketTaskRef)
        XCTAssertEqual(model.selection, WorkFindFixture.basketTaskRef)
        model.closeItem()
        model.openItem("w_finished1")
        await settle { model.visibleRefs.contains("w_finished1") }
        XCTAssertEqual(model.selection, "w_finished1")
        XCTAssertEqual(model.filter.states, [.done])
    }
}
