//
//  MarkdownViewerApp.swift
//  GenesisKit
//
//  A process whose only window is MarkdownDocumentWindowController's: Genesis runs it as `Genesis Markdown.app`,
//  GenesisTools as `GenesisTools --markdown`. No SwiftUI `App`, because a SwiftUI scene would insist on a main
//  window of its own; the menu is built by hand, since without an Edit menu ⌘C/⌘V/⌘Z never reach the text views.
//

import AppKit

/// What a host passes to run the viewer as its own process.
public struct MarkdownViewerAppConfiguration {
    /// The name in the app menu ("Hide …", "Quit …").
    public var appName: String
    /// A defaults suite reads fall through to (Genesis: the main app's, so tabs, zoom and frame carry over).
    public var defaultsSuite: String?
    /// Files to open once launch completes, besides whatever macOS opens.
    public var paths: [String]
    /// Whether those files bring the window to the front (false for a background launch, `open -g`).
    public var focus: Bool
    /// The changes to show for the last of those files (`--diff`), in the Changes mode.
    public var diff: MarkdownDiffRequest?
    /// Runs before the run loop starts, for the host's own launch setup (tooltip theme, hang watch).
    public var prepare: () -> Void
    /// A URL that reached this process (the host's scheme): route it, usually to
    /// `MarkdownDocumentWindowController.shared.show(paths:focus:range:)`.
    public var handleURL: (URL) -> Void

    public init(
        appName: String,
        defaultsSuite: String? = nil,
        paths: [String] = [],
        focus: Bool = true,
        diff: MarkdownDiffRequest? = nil,
        prepare: @escaping () -> Void = {},
        handleURL: @escaping (URL) -> Void
    ) {
        self.appName = appName
        self.defaultsSuite = defaultsSuite
        self.paths = paths
        self.focus = focus
        self.diff = diff
        self.prepare = prepare
        self.handleURL = handleURL
    }
}

@MainActor
public enum MarkdownViewerApp {
    private static var delegate: MarkdownViewerDelegate?

    /// Runs this process as the markdown viewer. Never returns.
    public static func run(_ configuration: MarkdownViewerAppConfiguration) -> Never {
        if let suite = configuration.defaultsSuite {
            // Reads fall through to the suite; writes land in this process's own domain and shadow it.
            UserDefaults.standard.addSuite(named: suite)
        }
        PerfLog.phase("viewer.init")
        configuration.prepare()
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = MarkdownViewerDelegate(
            handle: configuration.handleURL, initialPaths: configuration.paths, initialFocus: configuration.focus,
            initialDiff: configuration.diff
        )
        self.delegate = delegate
        app.delegate = delegate
        app.mainMenu = PerfLog.span("viewer.init.menu") { MarkdownViewerMenu.build(appName: configuration.appName) }
        app.windowsMenu = app.mainMenu?.items.last?.submenu
        PerfLog.span("viewer.init.controller") { _ = MarkdownDocumentWindowController.shared }
        PerfLog.phase("viewer.init.done")
        app.run()
        exit(0)
    }
}

public final class MarkdownViewerDelegate: NSObject, NSApplicationDelegate {
    private var controller: MarkdownDocumentWindowController {
        MainActor.assumeIsolated { MarkdownDocumentWindowController.shared }
    }

    /// URLs that arrive before launch is complete wait here. The URL that
    /// launches the process is delivered ~50 ms BEFORE didFinishLaunching,
    /// and a window ordered front that early never appears (observed
    /// 2026-09-15 15:00: `open -g genesis-md://open?focus=0` left a live
    /// process with no window). Every URL handled after launch showed one.
    public private(set) var pendingURLs: [URL] = []
    public private(set) var launched = false
    /// Replaced by tests; the host routes the URL.
    public var handle: (URL) -> Void
    private let initialPaths: [String]
    private let initialFocus: Bool
    private let initialDiff: MarkdownDiffRequest?

    public init(handle: @escaping (URL) -> Void, initialPaths: [String] = [], initialFocus: Bool = true, initialDiff: MarkdownDiffRequest? = nil) {
        self.initialDiff = initialDiff
        self.handle = handle
        self.initialPaths = initialPaths
        self.initialFocus = initialFocus
    }

    public func applicationWillFinishLaunching(_ notification: Notification) {
        // Before didFinishLaunching, so the URL that launched us is caught.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURLEvent(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        PerfLog.phase("viewer.didFinishLaunching")
        finishLaunching()
        if !initialPaths.isEmpty {
            MainActor.assumeIsolated { controller.show(paths: initialPaths, focus: initialFocus, diff: initialDiff) }
        }
        // Next turn of the run loop, so the document window is up first.
        DispatchQueue.main.async {
            MainActor.assumeIsolated { MarkdownDefaultAppDialog.shared.promptOnceIfNeeded() }
        }
    }

    /// Marks launch complete and replays what waited.
    public func finishLaunching() {
        launched = true
        let queued = pendingURLs
        pendingURLs = []
        for url in queued { handle(url) }
    }

    public func receive(_ url: URL) {
        if launched {
            handle(url)
        } else {
            GenesisKit.log("viewer: url queued until launch completes")
            pendingURLs.append(url)
        }
    }

    @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: text) else {
            GenesisKit.log("viewer: url event carried no readable URL")
            return
        }
        GenesisKit.log("viewer: url event received: \(url.absoluteString)")
        receive(url)
    }

    /// A file dropped on the Dock icon, or opened with "Open With".
    /// A file open never carries a line: Launch Services drops the `#L5` of a
    /// `file:///x.md#L5` before it gets here (2026-10-07, both `open` and
    /// `NSWorkspace.open`). A line travels in the host's URL instead (`genesis-md://open?path=…&range=…`).
    public func application(_ application: NSApplication, open urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        GenesisKit.log("viewer: open \(files.count) file(s): \(files.map(\.absoluteString).joined(separator: ", "))")
        let paths = files.map(\.path)
        guard !paths.isEmpty else { return }
        MainActor.assumeIsolated { controller.show(paths: paths, focus: true) }
    }

    /// Launched from the Dock or Spotlight with nothing to open: the tabs it
    /// had last time.
    public func applicationOpenUntitledFile(_ sender: NSApplication) -> Bool {
        MainActor.assumeIsolated { controller.show(paths: [], focus: true) }
        return true
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            MainActor.assumeIsolated { controller.show(paths: [], focus: true) }
        }
        return false
    }

    /// The viewer exists for its one window: closing it (or the last tab) is
    /// quitting, which is what takes the Dock icon away again.
    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// ⌘Q with unsaved tabs asks per tab, exactly like closing the window.
    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            guard let window = controller.window, window.isVisible else { return .terminateNow }
            return controller.windowShouldClose(window) ? .terminateNow : .terminateCancel
        }
    }
}

/// The menu bar of the viewer process. Only what the window needs; the
/// document shortcuts (⌘S, ⌘F, ⌘E, zoom…) already live on the SwiftUI
/// buttons inside the window and win over the menu when it is key.
@MainActor
public enum MarkdownViewerMenu {
    public static func build(appName: String) -> NSMenu {
        let menu = NSMenu()

        let appMenu = NSMenu()
        if GenesisKit.host?.markdownDefaultAppBundleID != nil {
            let setDefault = appMenu.addItem(
                withTitle: "Set as Default App…", action: #selector(MarkdownDefaultAppDialog.showChooser(_:)), keyEquivalent: ""
            )
            setDefault.target = MarkdownDefaultAppDialog.shared
            appMenu.addItem(.separator())
        }
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(
            withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(submenu(appMenu, title: appName))

        let file = NSMenu(title: "File")
        file.addItem(
            withTitle: "Close Tab",
            action: #selector(MarkdownDocumentWindowController.closeSelectedTab(_:)),
            keyEquivalent: "w"
        )
        let closeWindow = file.addItem(
            withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"
        )
        closeWindow.keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        let goTo = file.addItem(
            withTitle: "Go to Location…", action: #selector(MarkdownDocumentWindowController.goToLocation(_:)), keyEquivalent: "g"
        )
        goTo.keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        file.addItem(
            withTitle: "Save", action: #selector(MarkdownDocumentWindowController.saveSelected(_:)), keyEquivalent: "s"
        )
        menu.addItem(submenu(file, title: "File"))

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(submenu(edit, title: "Edit"))

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        menu.addItem(submenu(window, title: "Window"))

        return menu
    }

    private static func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
}
