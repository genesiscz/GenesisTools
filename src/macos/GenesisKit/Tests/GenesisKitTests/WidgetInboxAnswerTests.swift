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
        model.receive([String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)])
        XCTAssertNil(model.snapshot?.state.preferencesUnreadable)
        XCTAssertEqual(model.inboxOverviewItems.count, items.count)
        return model
    }

    static func draw(_ view: some View, size: CGSize, name: String? = nil,
                     interact: (NSWindow, NSView) throws -> Void = { _, _ in }) throws -> [String] {
        let contents = view.padding(8).frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(NativeThemePalette.graphiteBase).environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(contents, size: size)
        defer { window.close() }
        settle()
        try interact(window, host)
        settle()
        if let name, let folder = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
            let output = URL(fileURLWithPath: folder, isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            let image = try XCTUnwrap(HostedShot.bitmap(host))
            try XCTUnwrap(image.representation(using: .png, properties: [:]))
                .write(to: output.appendingPathComponent(name + ".png"))
        }
        return TreeDrawnText.placed(in: host).sorted { $0.middle < $1.middle }.map(\.text)
    }

    static func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.35)) }
}

@MainActor
final class WidgetInboxAnswerTests: XCTestCase {
    private let session = WidgetInboxRender.session("alpha", project: "Orchard")
    private let size = CGSize(width: 460, height: 520)

    private func opened(_ item: WidgetInboxItem, name: String? = nil) throws -> [String] {
        var preferences = WidgetPreferences.hubDefaults
        preferences.inboxGrouping = "session"
        let model = try WidgetInboxRender.model(sessions: [session], items: [item], preferences: preferences)
        defer { model.stop() }
        model.expanded = .right
        model.inboxOverview = true
        return try WidgetInboxRender.draw(ScrollView { WidgetInboxOverview(model: model) }, size: size, name: name) { _, _ in
            XCTAssertTrue(model.moveInList(.down))
            WidgetInboxRender.settle()
            XCTAssertTrue(model.moveInList(.open))
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
        XCTAssertFalse(after.contains("Question"), after.description)
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
                                      kind: "answer", key: session.key, at: 5000, needsAnswer: false, title: "Delivery", tag: "message")
        let note = try opened(message)
        XCTAssertTrue(note.contains("Message"), note.description)
        XCTAssertTrue(note.joined().contains("The baskets have arrived"), note.description)
        let decision = WidgetInboxItem(id: "decision:d", sourceId: "d", kind: "decision", key: session.key, at: 5000,
                                      needsAnswer: false, title: "Choose a crate", options: ["unused option"],
                                      option: "a", answer: "Use the small one.")
        let lines = try opened(decision)
        XCTAssertTrue(lines.contains("Your answer"), lines.description)
        XCTAssertTrue(lines.joined().contains("Use the small one"), lines.description)
        XCTAssertFalse(lines.joined().contains("unused option"), lines.description)
    }
}
