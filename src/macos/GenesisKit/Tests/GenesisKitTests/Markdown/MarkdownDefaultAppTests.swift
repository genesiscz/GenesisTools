import UniformTypeIdentifiers
import XCTest
@testable import GenesisKit

/// Genesis Markdown offering itself as the default app. Launch Services is
/// faked: a test must never change which app opens the user's files.
@MainActor
final class MarkdownDefaultAppTests: XCTestCase {
    private let viewerID = "dev.example.viewer"

    /// Handlers keyed by content type id; `set` records what was asked for.
    private final class FakeLaunchServices {
        var handlers: [String: URL] = [:]
        var setCalls: [String] = []
        var refuse: Set<String> = []

        var services: MarkdownDefaultApp.LaunchServices {
            MarkdownDefaultApp.LaunchServices(
                handler: { [unowned self] in handlers[$0.identifier] },
                setHandler: { [unowned self] app, type in
                    setCalls.append(type.identifier)
                    if refuse.contains(type.identifier) { throw CocoaError(.userCancelled) }
                    handlers[type.identifier] = app
                }
            )
        }
    }

    func testTheListIsTheRequestedExtensionsWithMarkdownPreselected() {
        XCTAssertEqual(
            MarkdownDefaultApp.extensions, ["md", "markdown", "mdx", "txt", "json", "yaml", "yml", "canvas", "base"]
        )
        XCTAssertEqual(MarkdownDefaultApp.preselected, ["md", "markdown", "mdx"])
    }

    func testEveryListedExtensionHasAContentTypeLaunchServicesCanKeyOn() {
        for ext in MarkdownDefaultApp.extensions {
            XCTAssertNotNil(MarkdownDefaultApp.type(for: ext), ext)
        }
        // .md/.markdown and .yaml/.yml share a type, so they change together.
        XCTAssertEqual(MarkdownDefaultApp.type(for: "md"), MarkdownDefaultApp.type(for: "markdown"))
        XCTAssertEqual(MarkdownDefaultApp.type(for: "yaml"), MarkdownDefaultApp.type(for: "yml"))
    }

    func testThePromptShowsOnlyWhileUnansweredAndSomethingOpensElsewhere() {
        let owned = MarkdownDefaultApp.Status(ext: "md", typeID: "a", handlerID: viewerID, handlerName: nil, isDefault: true)
        let other = MarkdownDefaultApp.Status(ext: "txt", typeID: "b", handlerID: "x", handlerName: "TextEdit", isDefault: false)
        XCTAssertTrue(MarkdownDefaultApp.shouldPrompt(answered: false, statuses: [owned, other]))
        XCTAssertFalse(MarkdownDefaultApp.shouldPrompt(answered: true, statuses: [owned, other]))
        // Owning everything does not spend the one question.
        XCTAssertFalse(MarkdownDefaultApp.shouldPrompt(answered: false, statuses: [owned]))
    }

    func testStatusNamesTheCurrentHandlerAndMarksOnlyThisBundleAsDefault() {
        let fake = FakeLaunchServices()
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        fake.handlers[UTType.plainText.identifier] = textEdit
        let txt = MarkdownDefaultApp.status(ext: "txt", bundleID: viewerID, services: fake.services)
        XCTAssertEqual(txt.handlerID, "com.apple.TextEdit")
        XCTAssertEqual(txt.handlerName, "TextEdit")
        XCTAssertFalse(txt.isDefault)
        XCTAssertEqual(
            MarkdownDefaultAppDialog.rowTitle(txt, statuses: [txt]), ".txt  (now opens in TextEdit)"
        )
        let owned = MarkdownDefaultApp.status(ext: "txt", bundleID: "com.apple.TextEdit", services: fake.services)
        XCTAssertTrue(owned.isDefault)
        XCTAssertEqual(MarkdownDefaultAppDialog.rowTitle(owned, statuses: [owned]), ".txt  (default already)")
    }

    func testRowsNameTheSiblingThatSharesTheirType() {
        let fake = FakeLaunchServices()
        let statuses = MarkdownDefaultApp.statuses(bundleID: viewerID, services: fake.services)
        XCTAssertEqual(MarkdownDefaultApp.sharesType("yml", in: statuses), ["yaml"])
        XCTAssertEqual(MarkdownDefaultApp.sharesType("json", in: statuses), [])
        let yml = statuses.first { $0.ext == "yml" }!
        XCTAssertEqual(MarkdownDefaultAppDialog.rowTitle(yml, statuses: statuses), ".yml  (now opens in no app), same type as .yaml")
    }

    func testApplySetsEachContentTypeOnceAndReportsARefusalForEverySiblingExtension() async {
        let fake = FakeLaunchServices()
        fake.refuse = [UTType.yaml.identifier]
        let app = URL(fileURLWithPath: "/Applications/Genesis Markdown.app")
        let failures = await MarkdownDefaultApp.apply(
            extensions: ["md", "markdown", "yaml", "yml", "canvas"], appURL: app, services: fake.services
        )
        let markdown = MarkdownDefaultApp.type(for: "md")!.identifier
        let canvas = MarkdownDefaultApp.type(for: "canvas")!.identifier
        // One call per type, in order: md and markdown share one, yaml and yml another.
        XCTAssertEqual(fake.setCalls, [markdown, UTType.yaml.identifier, canvas])
        XCTAssertEqual(Set(failures.keys), ["yaml", "yml"])
        XCTAssertEqual(fake.handlers[markdown], app)
        XCTAssertEqual(fake.handlers[canvas], app)
    }

    func testTheAppMenuOffersSetAsDefaultAppWiredToTheChooser() {
        final class OfferingHost: NSObject, GenesisKitHost {
            var markdownDefaultAppBundleID: String? { "dev.example.viewer" }
        }
        defer { GenesisKit.install(nil) }
        GenesisKit.install(nil)
        XCTAssertNil(
            MarkdownViewerMenu.build(appName: "Viewer").items.first?.submenu?.items.first { $0.title == "Set as Default App…" },
            "an app that does not offer itself as the default shows no such item"
        )

        GenesisKit.install(OfferingHost())
        let appMenu = MarkdownViewerMenu.build(appName: "Viewer").items.first?.submenu
        let item = appMenu?.items.first { $0.title == "Set as Default App…" }
        XCTAssertNotNil(item)
        XCTAssertEqual(item?.action, #selector(MarkdownDefaultAppDialog.showChooser(_:)))
        XCTAssertTrue(item?.target === MarkdownDefaultAppDialog.shared)
    }

    func testTheLaunchPromptDoesNothingOutsideTheViewerBundle() {
        // The test runner is not Genesis Markdown.app, so no modal may appear
        // and the answered flag stays untouched.
        let suite = "MarkdownDefaultAppTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let dialog = MarkdownDefaultAppDialog.shared
        let saved = (dialog.services, dialog.defaults)
        defer { (dialog.services, dialog.defaults) = saved }
        dialog.services = FakeLaunchServices().services
        dialog.defaults = defaults
        dialog.promptOnceIfNeeded()
        XCTAssertNil(defaults.object(forKey: MarkdownDefaultApp.promptAnsweredKey))
    }
}
