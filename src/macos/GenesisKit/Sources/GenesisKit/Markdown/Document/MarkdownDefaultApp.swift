//
//  MarkdownDefaultApp.swift
//  GenesisKit
//
//  Genesis Markdown offers to become the default app for the file types it
//  reads, so a fresh machine needs no `duti` step. Once per install, on a
//  launch where some type still opens elsewhere, it asks; whatever the answer,
//  it never asks again, and "Set as Default App…" in the app menu opens the
//  same per-extension chooser at any time.
//
//  Launch Services keys the default by content type, not by extension, so
//  extensions that share a type (.md/.markdown, .yaml/.yml) change together.
//  An extension no app declares (.mdx, .canvas, .base) has a dynamic type,
//  which Launch Services accepts the same way.
//

import AppKit
import UniformTypeIdentifiers

enum MarkdownDefaultApp {
    /// The extensions the chooser lists, in this order.
    static let extensions = ["md", "markdown", "mdx", "txt", "json", "yaml", "yml", "canvas", "base"]
    /// Checked in the chooser when they are not already the default.
    static let preselected: Set<String> = ["md", "markdown", "mdx"]
    /// Set once the launch prompt was answered either way; it never shows again.
    static let promptAnsweredKey = "markdownViewer.defaultAppPromptAnswered"

    /// What Launch Services says about one extension right now.
    struct Status: Equatable {
        let ext: String
        let typeID: String?
        let handlerID: String?
        let handlerName: String?
        let isDefault: Bool
    }

    /// The Launch Services calls, replaced by tests.
    struct LaunchServices {
        var handler: (UTType) -> URL?
        var setHandler: (URL, UTType) async throws -> Void

        static let live = LaunchServices(
            handler: { NSWorkspace.shared.urlForApplication(toOpen: $0) },
            setHandler: { app, type in try await NSWorkspace.shared.setDefaultApplication(at: app, toOpen: type) }
        )
    }

    static func type(for ext: String) -> UTType? {
        UTType(filenameExtension: ext)
    }

    static func status(ext: String, bundleID: String, services: LaunchServices) -> Status {
        guard let type = type(for: ext) else {
            return Status(ext: ext, typeID: nil, handlerID: nil, handlerName: nil, isDefault: false)
        }
        let app = services.handler(type)
        let bundle = app.flatMap { Bundle(url: $0) }
        let name = app.map { FileManager.default.displayName(atPath: $0.path).replacingOccurrences(of: ".app", with: "") }
        let handlerID = bundle?.bundleIdentifier
        return Status(ext: ext, typeID: type.identifier, handlerID: handlerID, handlerName: name, isDefault: handlerID == bundleID)
    }

    static func statuses(bundleID: String, services: LaunchServices) -> [Status] {
        extensions.map { status(ext: $0, bundleID: bundleID, services: services) }
    }

    /// The launch prompt shows only while unanswered and only when some type
    /// opens elsewhere. An install that already owns every type does not use
    /// up the one question.
    static func shouldPrompt(answered: Bool, statuses: [Status]) -> Bool {
        !answered && statuses.contains { !$0.isDefault }
    }

    /// The other listed extensions with the same content type as `ext`.
    static func sharesType(_ ext: String, in statuses: [Status]) -> [String] {
        guard let id = statuses.first(where: { $0.ext == ext })?.typeID else { return [] }
        return statuses.filter { $0.typeID == id && $0.ext != ext }.map(\.ext)
    }

    /// Sets the app as the default for each chosen extension, one content
    /// type at a time, so a confirmation macOS shows for one never overlaps
    /// the next. Returns the error per extension that failed; an extension
    /// whose type was already set through a sibling reuses that result.
    static func apply(extensions chosen: [String], appURL: URL, services: LaunchServices) async -> [String: Error] {
        var failures: [String: Error] = [:]
        var done: [String: Error?] = [:]
        for ext in chosen {
            guard let type = type(for: ext) else {
                failures[ext] = DefaultAppError.noContentType(ext)
                continue
            }
            if let previous = done[type.identifier] {
                if let previous { failures[ext] = previous }
                continue
            }
            do {
                try await services.setHandler(appURL, type)
                done[type.identifier] = .some(nil)
                GenesisKit.log("viewer: default app set for .\(ext) (\(type.identifier))")
            } catch {
                done[type.identifier] = .some(error)
                failures[ext] = error
                GenesisKit.log("viewer: default app refused for .\(ext) (\(type.identifier)): \(error.localizedDescription)")
            }
        }
        return failures
    }

    enum DefaultAppError: LocalizedError {
        case noContentType(String)

        var errorDescription: String? {
            switch self {
            case .noContentType(let ext): "macOS has no content type for .\(ext)"
            }
        }
    }
}

/// The launch prompt and the per-extension chooser.
@MainActor
final class MarkdownDefaultAppDialog: NSObject {
    static let shared = MarkdownDefaultAppDialog()

    var services = MarkdownDefaultApp.LaunchServices.live
    var defaults = UserDefaults.standard
    private var activationObserver: NSObjectProtocol?

    private var bundleID: String { GenesisKit.host?.markdownDefaultAppBundleID ?? Bundle.main.bundleIdentifier ?? "" }

    private func currentStatuses() -> [MarkdownDefaultApp.Status] {
        MarkdownDefaultApp.statuses(bundleID: bundleID, services: services)
    }

    /// Called once after launch. Waits until the app is active, so a viewer
    /// opened in the background (`focus=0`) does not put a modal over
    /// whatever the user is doing.
    func promptOnceIfNeeded() {
        guard GenesisKit.host?.markdownDefaultAppBundleID != nil else { return }
        let answered = defaults.bool(forKey: MarkdownDefaultApp.promptAnsweredKey)
        guard MarkdownDefaultApp.shouldPrompt(answered: answered, statuses: currentStatuses()) else { return }
        if NSApp.isActive {
            showLaunchPrompt()
            return
        }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.activatedForPrompt() }
        }
    }

    private func activatedForPrompt() {
        if let activationObserver { NotificationCenter.default.removeObserver(activationObserver) }
        activationObserver = nil
        showLaunchPrompt()
    }

    private func showLaunchPrompt() {
        let statuses = currentStatuses()
        let answered = defaults.bool(forKey: MarkdownDefaultApp.promptAnsweredKey)
        guard MarkdownDefaultApp.shouldPrompt(answered: answered, statuses: statuses) else { return }
        let missing = statuses.filter { !$0.isDefault }.map { ".\($0.ext)" }.joined(separator: ", ")

        let alert = NSAlert()
        alert.messageText = "Make Genesis Markdown your default app?"
        alert.informativeText = """
            Other apps open these files now: \(missing).

            You can change this later with Genesis Markdown → Set as Default App….
            """
        alert.addButton(withTitle: "Make Default…")
        alert.addButton(withTitle: "Not Now")
        // Recorded before the answer, so a crash or a force quit in the
        // middle cannot bring the question back.
        defaults.set(true, forKey: MarkdownDefaultApp.promptAnsweredKey)
        GenesisKit.log("viewer: default-app prompt shown (not default for \(missing))")
        let response = alert.runModal()
        GenesisKit.log("viewer: default-app prompt answered: \(response == .alertFirstButtonReturn ? "make default" : "not now")")
        if response == .alertFirstButtonReturn {
            showChooser(nil)
        }
    }

    /// "Set as Default App…": one checkbox per extension with its current
    /// handler. An extension the app already owns shows checked and disabled.
    @objc func showChooser(_ sender: Any?) {
        let statuses = currentStatuses()
        var boxes: [(ext: String, box: NSButton)] = []
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        for status in statuses {
            let box = NSButton(checkboxWithTitle: Self.rowTitle(status, statuses: statuses), target: nil, action: nil)
            if status.isDefault {
                box.state = .on
                box.isEnabled = false
            } else {
                box.state = MarkdownDefaultApp.preselected.contains(status.ext) ? .on : .off
                box.isEnabled = status.typeID != nil
            }
            boxes.append((status.ext, box))
            stack.addArrangedSubview(box)
        }
        stack.layoutSubtreeIfNeeded()
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)

        let alert = NSAlert()
        alert.messageText = "Open these files with Genesis Markdown?"
        alert.informativeText = "Each checked extension opens in Genesis Markdown from Finder and from the terminal. macOS may ask you to confirm."
        alert.accessoryView = stack
        alert.addButton(withTitle: "Set as Default")
        alert.addButton(withTitle: "Cancel")
        if statuses.allSatisfy(\.isDefault) {
            alert.informativeText = "Genesis Markdown already opens every one of these file types."
            alert.buttons.first?.isEnabled = false
        }
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let chosen = boxes.filter { $0.box.isEnabled && $0.box.state == .on }.map(\.ext)
        guard !chosen.isEmpty else { return }
        Task { @MainActor in
            let failures = await MarkdownDefaultApp.apply(
                extensions: chosen, appURL: Bundle.main.bundleURL, services: services
            )
            showResult(chosen: chosen, failures: failures)
        }
    }

    static func rowTitle(_ status: MarkdownDefaultApp.Status, statuses: [MarkdownDefaultApp.Status]) -> String {
        var title = ".\(status.ext)"
        if status.typeID == nil {
            title += "  (macOS has no type for it)"
        } else if status.isDefault {
            title += "  (default already)"
        } else {
            title += "  (now opens in \(status.handlerName ?? "no app"))"
        }
        let siblings = MarkdownDefaultApp.sharesType(status.ext, in: statuses)
        if !siblings.isEmpty {
            title += ", same type as " + siblings.map { ".\($0)" }.joined(separator: ", ")
        }
        return title
    }

    private func showResult(chosen: [String], failures: [String: Error]) {
        let after = currentStatuses()
        let set = chosen.filter { ext in after.first { $0.ext == ext }?.isDefault == true }
        let notSet = chosen.filter { !set.contains($0) }
        let alert = NSAlert()
        if notSet.isEmpty {
            alert.messageText = "Genesis Markdown is now the default app"
            alert.informativeText = "It opens " + set.map { ".\($0)" }.joined(separator: ", ") + " files."
        } else {
            alert.alertStyle = .warning
            alert.messageText = "Some file types still open in another app"
            let lines = notSet.map { ext in
                ".\(ext): " + (failures[ext]?.localizedDescription ?? "macOS kept the previous app")
            }
            alert.informativeText = lines.joined(separator: "\n")
        }
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
