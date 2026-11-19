import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// An isolated widget fed the same wire snapshot the watch publishes. Drawing uses a window off screen.
@MainActor
enum WidgetInboxRender {
    static func session(_ name: String, project: String) -> WidgetSession {
        WidgetSession(key: "local:codex:" + name + ":",
                      target: .init(hostId: "local", provider: "codex", sessionId: name, sourceHome: "", cwd: "/fixture"),
                      title: name.capitalized, project: project, activityAt: 5000, status: "working",
                      pinned: false, visible: true, hiddenByFilter: false)
    }

    static func model(sessions: [WidgetSession], items: [WidgetInboxItem],
                      preferences: WidgetPreferences = .hubDefaults) throws -> WidgetModel {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.fixture." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/usr/bin/true", stateRoot: root.path, defaults: defaults,
            appearance: NativeSettingsAppearance(defaults: defaults, notificationNamespace: UUID().uuidString,
                                                 observeExternalChanges: false))
        model.entryBodyReader = { id in
            guard let row = items.first(where: { $0.sourceId == id }) else { throw CocoaError(.fileNoSuchFile) }
            return WidgetEntryBody(body: row.reply?.text ?? row.message?.text ?? "", question: row.reply?.question)
        }
        try receive(model, sessions: sessions, items: items, preferences: preferences)
        return model
    }

    static func receive(_ model: WidgetModel, sessions: [WidgetSession], items: [WidgetInboxItem],
                        preferences: WidgetPreferences) throws {
        let groups = sessions.map { session in
            let rows = items.filter { $0.key == session.key }
            return WidgetInboxSession(key: session.key, unread: rows.filter { !$0.needsAnswer }.count,
                                      needsAnswer: rows.filter(\.needsAnswer).count, latest: rows.first,
                                      unreadItem: rows.first { !$0.needsAnswer }, pendingItem: rows.first(where: \.needsAnswer),
                                      items: rows)
        }
        let summary = WidgetInboxSummary(unread: groups.map(\.unread).reduce(0, +),
                                         needsAnswer: groups.map(\.needsAnswer).reduce(0, +),
                                         complete: true, truncated: false, sessions: groups)
        let state = WidgetState(version: 1, revision: 1, preferences: preferences, assets: [:], drafts: [:], outgoing: [])
        let snapshot = WidgetSnapshot(notifications: summary, version: 1, state: state, sessions: sessions,
                                      cards: [], manifests: [:], errors: [])
        let data = try JSONEncoder().encode(snapshot)
        XCTAssertNil(try JSONDecoder().decode(WidgetSnapshot.self, from: data).state.preferencesUnreadable)
        model.receive([try XCTUnwrap(String(bytes: data, encoding: .utf8))])
        XCTAssertEqual(model.preferences.inboxGrouping, preferences.inboxGrouping)
        XCTAssertEqual(model.inboxOverviewItems.count, items.count)
    }

    static func draw(_ view: some View, size: CGSize, name: String? = nil,
                     waitForDetail: Bool = false,
                     interact: (NSWindow, NSView) throws -> Void = { _, _ in }) throws -> [String] {
        let contents = view.padding(8).frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(NativeThemePalette.graphiteBase).environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(contents, size: size)
        defer { window.close() }
        if !waitForDetail { settle() }
        try interact(window, host)
        if !waitForDetail { settle() }
        if let name, let folder = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
            let output = URL(fileURLWithPath: folder, isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let image = try XCTUnwrap(HostedShot.bitmap(host))
            try XCTUnwrap(image.representation(using: .png, properties: [:]))
                .write(to: output.appendingPathComponent(name + ".png"))
        }
        return lines(in: host)
    }

    static func lines(in host: NSView) -> [String] {
        TreeDrawnText.placed(in: host).sorted { $0.middle < $1.middle }.map(\.text)
    }

    static func waitFor(_ transition: String, until ready: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        repeat {
            if ready() { return }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        } while Date() < deadline
        XCTFail("Timed out waiting for \(transition)")
    }

    static func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.35)) }
}

@MainActor
final class WidgetInboxAnswerTests: XCTestCase {
    private let session = WidgetInboxRender.session("alpha", project: "Orchard")
    private let size = CGSize(width: 460, height: 520)

    private func opened(_ item: WidgetInboxItem, name: String? = nil, failReceipt: Bool = false) throws -> [String] {
        var preferences = WidgetPreferences.hubDefaults
        preferences.inboxGrouping = "session"
        let model = try WidgetInboxRender.model(sessions: [session], items: [item], preferences: preferences)
        defer { model.stop() }
        if failReceipt { model.entryBodyReader = { _ in throw CocoaError(.fileNoSuchFile) } }
        model.expanded = .right
        model.inboxOverview = true
        let list = WidgetInboxOverview(model: model, viewport: { content in AnyView(ScrollView { content }) })
        return try WidgetInboxRender.draw(list, size: size, name: name, waitForDetail: true) { _, host in
            openRow(model, host: host)
            if failReceipt {
                WidgetInboxRender.waitFor("receipt failure to paint") {
                    WidgetInboxRender.lines(in: host).contains { $0.contains("Try again") }
                }
            }
        }
    }

    private func openRow(_ model: WidgetModel, host: NSView) {
        WidgetInboxRender.waitFor("overview keyboard focus") {
            if model.inboxOverviewHasFocus { return true }
            model.moveInList(.down)
            return false
        }
        XCTAssertTrue(model.moveInList(.open))
        WidgetInboxRender.waitFor("expanded row to paint") {
            WidgetInboxRender.lines(in: host).contains("Open in its session")
        }
    }

    func testOpeningAGroupedAnswerAddsTheAnswerAndKeepsAShortQuestionInTheHead() throws {
        var item = WidgetInboxItem(id: "answer:a3", sourceId: "a3", kind: "answer", key: session.key,
                                   at: 5000, needsAnswer: false, title: "Which fruit is ripe?", count: 3)
        let before = try opened(item, name: "answer-before")
        item.reply = .init(question: "Which fruit is ripe?", text: "The pears are ready.")
        let after = try opened(item, name: "answer-after")
        XCTAssertFalse(before.joined().contains("The pears are ready"))
        XCTAssertTrue(after.contains("Answer"), after.description)
        XCTAssertTrue(after.joined().contains("The pears are ready"), after.description)
        XCTAssertTrue(after.joined().contains("2 earlier answers"), after.description)
        XCTAssertEqual(after.filter { $0 == "Alpha" }.count, 1, after.description)
        XCTAssertFalse(after.contains("Whole inbox"), "The group header already opens Alpha's whole inbox.")
        let question = try XCTUnwrap(after.firstIndex(of: "Which fruit is ripe?"), after.description)
        let answer = try XCTUnwrap(after.firstIndex(of: "Answer"), after.description)
        XCTAssertEqual(after.filter { $0 == "Which fruit is ripe?" }.count, 1)
        XCTAssertLessThan(question, answer)
        XCTAssertFalse(after.contains("Question"), after.description)
    }

    func testAFailedAttachmentReadKeepsThePreviewAndOffersRetryEvenWhenTheTextIsComplete() throws {
        let row = WidgetInboxItem(reply: .init(question: "Ready?", text: "The pears are ready."),
                                  id: "answer:short", sourceId: "short", kind: "answer", key: session.key,
                                  at: 5000, needsAnswer: false, title: "Ready?")
        let words = try opened(row, name: "answer-read-failure", failReceipt: true).joined(separator: " ")
        for phrase in ["The pears are ready", "Attachments could not be checked", "Try again", "Details"] {
            XCTAssertTrue(words.contains(phrase), words)
        }
    }

    func testALongQuestionHasItsOwnSection() throws {
        let question = String(repeating: "What did the harvest yield? ", count: 7) + "Include the pears."
        let item = WidgetInboxItem(reply: .init(question: question, text: "Two baskets."), id: "answer:a",
                                   sourceId: "a", kind: "answer", key: session.key, at: 5000, needsAnswer: false,
                                   title: String(question.prefix(159)) + "…")
        let lines = try opened(item)
        XCTAssertTrue(lines.contains("Question"), lines.description)
        XCTAssertTrue(lines.joined(separator: " ").contains("Include the pears"), lines.description)
    }

    func testMessagesAndDecidedDecisionsNameWhatIsBeingRead() throws {
        let message = WidgetInboxItem(message: .init(text: "The baskets have arrived."), id: "answer:m", sourceId: "m",
                                      kind: "answer", key: session.key, at: 5000, needsAnswer: false, title: "Delivery", count: 2, tag: "message")
        let note = try opened(message)
        XCTAssertTrue(note.contains("Message"), note.description)
        XCTAssertTrue(note.joined(separator: " ").contains("1 earlier message"), note.description)
        XCTAssertTrue(note.joined().contains("The baskets have arrived"), note.description)
        let decision = WidgetInboxItem(id: "decision:d", sourceId: "d", kind: "decision", key: session.key, at: 5000,
                                      needsAnswer: false, title: "Choose a crate", options: ["unused option"],
                                      option: "a", answer: "Use the small one.")
        let lines = try opened(decision)
        XCTAssertTrue(lines.contains("Your answer"), lines.description)
        XCTAssertTrue(lines.joined().contains("Use the small one"), lines.description)
        XCTAssertFalse(lines.joined().contains("unused option"), lines.description)
    }

    func testOpeningAReceiptReplacesThePreviewAndDrawsItsThumbnail() throws {
        let item = WidgetInboxItem(reply: .init(question: "Check the crates?", text: "Preview only."),
                                   id: "answer:receipt", sourceId: "receipt", kind: "answer",
                                   key: session.key, at: 5000, needsAnswer: false, title: "Check the crates?")
        let model = try WidgetInboxRender.model(sessions: [session], items: [item])
        defer { model.stop() }
        model.expanded = .right
        model.inboxOverview = true
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try MediaThumbnailCacheTests.writePNG(path, width: 400, height: 300, color: CGColor(red: 1, green: 0, blue: 1, alpha: 1))
        defer { try? FileManager.default.removeItem(at: path) }
        let image = WidgetImageReference(id: "img-fixture", path: path.path, name: "Crate photo", width: 400, height: 300)
        var reads = 0
        model.entryBodyReader = { id in
            XCTAssertEqual(id, "receipt")
            reads += 1
            return WidgetEntryBody(body: "The crates are ready.", question: "Check the crates?", attachments: [image])
        }
        let list = WidgetInboxOverview(model: model, viewport: { content in AnyView(ScrollView { content }) })
        let lines = try WidgetInboxRender.draw(list, size: size, name: "receipt-hosted", waitForDetail: true) { _, host in
            openRow(model, host: host)
            WidgetInboxRender.waitFor("receipt thumbnail to paint") { Self.hasMagentaPixels(host) }
            var newer = item
            newer.id = "answer:newer"
            newer.sourceId = "newer"
            newer.at += 1
            try WidgetInboxRender.receive(model, sessions: [session], items: [newer, item], preferences: .hubDefaults)
            WidgetInboxRender.waitFor("new row and open receipt to paint") {
                WidgetInboxRender.lines(in: host).filter { $0 == "Check the crates?" }.count == 2
                    && Self.hasMagentaPixels(host)
            }
        }
        XCTAssertEqual(reads, 1)
        XCTAssertTrue(lines.joined().contains("The crates are ready"), lines.description)
        XCTAssertFalse(lines.joined().contains("Preview only"), lines.description)
    }

    private static func hasMagentaPixels(_ host: NSView) -> Bool {
        guard let image = HostedShot.bitmap(host)?.cgImage,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: image.width, height: image.height,
                                      bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
              let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
        for y in stride(from: 0, to: image.height, by: 8) {
            for x in stride(from: 0, to: image.width, by: 8) {
                let pixel = y * context.bytesPerRow + x * 4
                if bytes[pixel] > 180, bytes[pixel + 1] < 100, bytes[pixel + 2] > 180 { return true }
            }
        }
        return false
    }

    /// `tools hub widget message-body` sends the lifted pictures with the whole text; an older CLI sends none.
    func testTheOpenedReceiptDecodesItsPicturesAndAnOlderReplyWithout() throws {
        let current = Data("""
        {"body":"It looks right.","question":"How does it look?","attachments":[{"id":"img1",\
        "path":"/tmp/after.png","name":"after.png","mimeType":"image/png","bytes":70,"width":2,"height":1,\
        "sha256":"abc","label":"After"}]}
        """.utf8)
        let read = try JSONDecoder().decode(WidgetEntryBody.self, from: current)
        XCTAssertEqual(read.attachments.map(\.path), ["/tmp/after.png"])
        XCTAssertEqual(read.attachments.first?.label, "After")
        let older = try JSONDecoder().decode(WidgetEntryBody.self, from: Data(#"{"body":"Text only."}"#.utf8))
        XCTAssertTrue(older.attachments.isEmpty)
        XCTAssertNil(older.question)
    }
}
