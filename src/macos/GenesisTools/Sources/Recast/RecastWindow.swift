import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
enum RecastConfiguration {
    static var toolsPath = ToolsBridge.defaultBinaryPath()
    static var initialDirectory: URL?
    static var contentType: UTType { UTType(exportedAs: RecastPackage.type, conformingTo: .package) }
}

@MainActor
final class RecastDocument: NSDocument {
    let model: RecastModel
    var onClose: (() -> Void)?

    override init() {
        model = RecastModel(toolsPath: RecastConfiguration.toolsPath)
        super.init()
        model.owner = self
        hasUndoManager = true
        undoManager = UndoManager()
        fileType = RecastPackage.type
    }
    override class var autosavesInPlace: Bool { true }
    override class var readableTypes: [String] { [RecastPackage.type] }
    override class var writableTypes: [String] { [RecastPackage.type] }

    override func makeWindowControllers() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1460, height: 920),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Recast · " + (model.file?.title ?? "Untitled conversion")
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = ReviewPalette.background
        window.minSize = NSSize(width: 860, height: 650)
        let host = NSHostingView(rootView: RecastView(model: model).defaultAppStorage(HubDefaults.store).titlebarZone())
        host.sizingOptions = []
        window.contentView = host
        window.center()
        addWindowController(NSWindowController(window: window))
    }

    override func fileWrapper(ofType typeName: String) throws -> FileWrapper {
        guard let state = model.state else { throw recastError("The conversion has not finished opening.") }
        return try RecastPackage.encode(state)
    }

    override func read(from fileWrapper: FileWrapper, ofType typeName: String) throws {
        let state = try RecastPackage.decode(fileWrapper)
        let publish: @MainActor () -> Void = { self.model.install(state) }
        if Thread.isMainThread { MainActor.assumeIsolated { publish() } }
        else { DispatchQueue.main.sync { publish() } }
    }

    override func prepareSavePanel(_ savePanel: NSSavePanel) -> Bool {
        savePanel.allowedContentTypes = [RecastConfiguration.contentType]
        savePanel.nameFieldStringValue = (model.file?.title ?? "Untitled conversion") + ".recast"
        if fileURL == nil { savePanel.directoryURL = RecastConfiguration.initialDirectory }
        return true
    }
    override func updateChangeCount(_ change: NSDocument.ChangeType) {
        super.updateChangeCount(change); model.objectWillChange.send()
    }
    @objc func importSources(_ sender: Any?) { model.chooseSources() }
    @objc func addRecord(_ sender: Any?) { model.addRecord() }
    @objc func extractRows(_ sender: Any?) { model.extractSelection(intoField: false) }
    @objc func readIntoField(_ sender: Any?) { model.extractSelection(intoField: true) }
    @objc func acceptRecord(_ sender: Any?) { model.acceptRecords(all: false) }
    @objc func previewExport(_ sender: Any?) { model.prepareExport() }
    @objc func importCSVEdits(_ sender: Any?) { model.chooseCSVEdits() }
    @objc func chooseRegion(_ sender: Any?) { model.showRegionEditor = true }
    @objc func revealEvidence(_ sender: Any?) { model.revealSelectedEvidence() }
    @objc func detachEvidence(_ sender: Any?) { model.revealSelectedEvidence(detached: true) }
    @objc func manageEvidence(_ sender: Any?) { model.openEvidence() }
    @objc func compareEvidence(_ sender: Any?) { model.openContradiction() }
    @objc func bulkCorrection(_ sender: Any?) { model.openBulk() }
    @objc func correctionExamples(_ sender: Any?) { model.openCorrectionExamples() }
    @objc func attachSelectedRegion(_ sender: Any?) { model.attachSelectedRegion() }
    override func close() { model.stop(); onClose?(); super.close() }
}

@MainActor
private final class RecastAppDelegate: NSObject, NSApplicationDelegate {
    var documents: [RecastDocument] = []
    var snapshotPath: String?
    var snapshotProposal = false
    var snapshotEvidence = false
    var snapshotContradiction = false
    var snapshotBulk = false
    var snapshotCorrection = false
    var snapshotCSV = false
    var snapshotField: String?
    var snapshotRecord: String?
    var snapshotEvidenceAnchor: String?
    var snapshotReadingIDs: [String]?
    var proposalOpened = false
    var proposalSnapshotWindow: NSWindow?
    var initialSource: URL?
    var initialCSV: URL?
    var captured = false
    var launchConversion: (() -> Void)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let launch = launchConversion
        launchConversion = nil
        launch?()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    func installMenu() {
        AppMainMenu.install()
        let file = NSMenu(title: "File")
        for (title, action, key) in [
            ("New Conversion", #selector(newConversion(_:)), "n"),
            ("Open Conversion…", #selector(openConversion(_:)), "o"),
            ("Recover Autosaved Conversion…", #selector(recoverConversion(_:)), "")
        ] {
            let item = file.addItem(withTitle: title, action: action, keyEquivalent: key); item.target = self
        }
        file.addItem(.separator())
        file.addItem(withTitle: "Import Sources…", action: #selector(RecastDocument.importSources(_:)), keyEquivalent: "i")
        file.addItem(withTitle: "Save", action: #selector(NSDocument.save(_:)), keyEquivalent: "s")
        file.addItem(withTitle: "Save As…", action: #selector(NSDocument.saveAs(_:)), keyEquivalent: "s").keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        file.addItem(withTitle: "Preview Export…", action: #selector(RecastDocument.previewExport(_:)), keyEquivalent: "e")
        file.addItem(withTitle: "Review CSV Edits…", action: #selector(RecastDocument.importCSVEdits(_:)), keyEquivalent: "")
        file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let item = NSMenuItem(title: "File", action: nil, keyEquivalent: ""); item.submenu = file
        NSApp.mainMenu?.insertItem(item, at: 1)
        let objects = NSMenu(title: "Objects")
        objects.addItem(withTitle: "Add Record", action: #selector(RecastDocument.addRecord(_:)), keyEquivalent: "n").keyEquivalentModifierMask = [.command, .shift]
        objects.addItem(withTitle: "Select Source Region…", action: #selector(RecastDocument.chooseRegion(_:)), keyEquivalent: "r").keyEquivalentModifierMask = [.command, .shift]
        objects.addItem(withTitle: "Extract Rows from Selection", action: #selector(RecastDocument.extractRows(_:)), keyEquivalent: "")
        objects.addItem(withTitle: "Read Selection into Field", action: #selector(RecastDocument.readIntoField(_:)), keyEquivalent: "\r")
        objects.addItem(withTitle: "Manage Field Evidence…", action: #selector(RecastDocument.manageEvidence(_:)), keyEquivalent: "")
        objects.addItem(withTitle: "Review Competing Evidence…", action: #selector(RecastDocument.compareEvidence(_:)), keyEquivalent: "")
        objects.addItem(withTitle: "Correct Selected Records…", action: #selector(RecastDocument.bulkCorrection(_:)), keyEquivalent: "e").keyEquivalentModifierMask = [.command, .option]
        objects.addItem(withTitle: "Suggest Source-Local Correction…", action: #selector(RecastDocument.correctionExamples(_:)), keyEquivalent: "")
        objects.addItem(withTitle: "Attach Selected Region…", action: #selector(RecastDocument.attachSelectedRegion(_:)), keyEquivalent: "")
        objects.addItem(withTitle: "Show Field Evidence", action: #selector(RecastDocument.revealEvidence(_:)), keyEquivalent: "l").keyEquivalentModifierMask = [.command, .shift]
        objects.addItem(withTitle: "Open Evidence Window", action: #selector(RecastDocument.detachEvidence(_:)), keyEquivalent: "l").keyEquivalentModifierMask = [.command, .option]
        objects.addItem(withTitle: "Accept Selected Record", action: #selector(RecastDocument.acceptRecord(_:)), keyEquivalent: "\r").keyEquivalentModifierMask = [.command, .shift]
        let objectItem = NSMenuItem(title: "Objects", action: nil, keyEquivalent: ""); objectItem.submenu = objects
        NSApp.mainMenu?.insertItem(objectItem, at: 3)
    }

    @objc func newConversion(_ sender: Any?) { create() }
    @objc func openConversion(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [RecastConfiguration.contentType]
        panel.allowsMultipleSelection = true
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            for url in panel.urls { self?.create(url: url) }
        }
    }

    @objc func recoverConversion(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.treatsFilePackagesAsDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .autosavedInformationDirectory, in: .userDomainMask).first
        panel.message = "Choose an autosaved Recast package. Recovery opens an independent unsaved conversion and preserves the original."
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.create(url: url, recovering: true)
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        guard snapshotPath == nil else { sender.reply(toOpenOrPrint: .cancel); return }
        let files = filenames.filter { $0.hasSuffix(".recast") }
        for filename in files {
            let url = URL(fileURLWithPath: filename).standardizedFileURL
            if !documents.contains(where: { $0.fileURL?.standardizedFileURL == url }) { create(url: url) }
        }
        sender.reply(toOpenOrPrint: files.isEmpty ? .cancel : .success)
    }

    func create(url: URL? = nil, kind: String = "table", recovering: Bool = false) {
        var pendingCSV = initialCSV
        initialCSV = nil
        let document = RecastDocument()
        document.fileURL = url
        document.makeWindowControllers()
        NSDocumentController.shared.addDocument(document)
        documents.append(document)
        document.onClose = { [weak self, weak document] in
            self?.documents.removeAll { $0 === document }
        }
        guard let window = document.windowControllers.first?.window else { return }
        if snapshotPath != nil { window.orderInForSnapshot() }
        else { document.showWindows(); window.makeKeyAndOrderFront(nil) }
        document.model.onReady = { [weak self, weak document, weak window] in
            guard let self, let document, let window else { return }
            if let initialSource {
                self.initialSource = nil
                document.model.importSources([initialSource])
                return
            }
            if let csv = pendingCSV, !document.model.busy, document.model.file != nil {
                pendingCSV = nil
                document.model.reviewCSV(url: csv)
                return
            }
            if let snapshotPath, !captured {
                guard !document.model.busy, !document.model.previewBusy, !document.model.audio.isLoading else { return }
                if snapshotProposal {
                    if !proposalOpened {
                        proposalOpened = true
                        document.model.openProposal(readingIDs: snapshotReadingIDs)
                        document.model.showAIProposal = false
                        let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 740),
                            styleMask: [.borderless], backing: .buffered, defer: false)
                        previewWindow.isReleasedWhenClosed = false
                        previewWindow.appearance = NSAppearance(named: .darkAqua)
                        previewWindow.backgroundColor = ReviewPalette.background
                        previewWindow.contentView = NSHostingView(rootView: RecastProposalSheet(model: document.model))
                        proposalSnapshotWindow = previewWindow
                        previewWindow.orderInForSnapshot()
                        return
                    }
                    guard document.model.proposalPreviewReady, proposalSnapshotWindow != nil else { return }
                }
                if snapshotEvidence && !proposalOpened {
                    proposalOpened = true
                    document.model.openEvidence(addingAnchorId: snapshotEvidenceAnchor)
                    document.model.showEvidenceSheet = false
                    guard let draft = document.model.evidenceDraft else { return }
                    let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 680),
                        styleMask: [.borderless], backing: .buffered, defer: false)
                    previewWindow.isReleasedWhenClosed = false
                    previewWindow.appearance = NSAppearance(named: .darkAqua)
                    previewWindow.backgroundColor = ReviewPalette.background
                    previewWindow.contentView = NSHostingView(rootView: RecastEvidenceSheet(model: document.model, draft: draft))
                    proposalSnapshotWindow = previewWindow
                    previewWindow.orderInForSnapshot()
                }
                if snapshotContradiction && !proposalOpened {
                    proposalOpened = true
                    document.model.openContradiction(reviewId: document.model.file?.contradictions?.first?.id)
                    document.model.showContradictionSheet = false
                    guard let draft = document.model.contradictionDraft else { return }
                    let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 760),
                        styleMask: [.borderless], backing: .buffered, defer: false)
                    previewWindow.isReleasedWhenClosed = false
                    previewWindow.appearance = NSAppearance(named: .darkAqua)
                    previewWindow.backgroundColor = ReviewPalette.background
                    previewWindow.contentView = NSHostingView(rootView: RecastContradictionSheet(model: document.model, draft: draft))
                    proposalSnapshotWindow = previewWindow
                    previewWindow.orderInForSnapshot()
                }
                if snapshotBulk && !proposalOpened {
                    proposalOpened = true
                    document.model.bulkRecordIDs = Set(document.model.records.prefix(2).map(\.id))
                    if let snapshotField { document.model.selectedField = snapshotField }
                    document.model.openBulk(); document.model.showBulkSheet = false
                    guard let draft = document.model.bulkDraft else { return }
                    let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 740),
                        styleMask: [.borderless], backing: .buffered, defer: false)
                    previewWindow.isReleasedWhenClosed = false
                    previewWindow.appearance = NSAppearance(named: .darkAqua)
                    previewWindow.backgroundColor = ReviewPalette.background
                    previewWindow.contentView = NSHostingView(rootView: RecastBulkSheet(model: document.model, draft: draft))
                    proposalSnapshotWindow = previewWindow
                    previewWindow.orderInForSnapshot()
                }
                if snapshotCorrection {
                    if !proposalOpened {
                        proposalOpened = true
                        if let snapshotField { document.model.selectedField = snapshotField }
                        if let snapshotRecord { document.model.selectedRecord = snapshotRecord }
                        document.model.openCorrectionExamples()
                        return
                    }
                    guard let preview = document.model.correctionExamples else { return }
                    document.model.showCorrectionExamples = false
                    if proposalSnapshotWindow == nil {
                        let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 740),
                            styleMask: [.borderless], backing: .buffered, defer: false)
                        previewWindow.isReleasedWhenClosed = false
                        previewWindow.appearance = NSAppearance(named: .darkAqua)
                        previewWindow.backgroundColor = ReviewPalette.background
                        previewWindow.contentView = NSHostingView(rootView: RecastCorrectionSheet(model: document.model, preview: preview))
                        proposalSnapshotWindow = previewWindow
                        previewWindow.orderInForSnapshot()
                    }
                }
                if snapshotCSV {
                    guard let draft = document.model.roundTrip else { return }
                    document.model.showRoundTrip = false
                    if proposalSnapshotWindow == nil {
                        let previewWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 890, height: 700),
                            styleMask: [.borderless], backing: .buffered, defer: false)
                        previewWindow.isReleasedWhenClosed = false
                        previewWindow.appearance = NSAppearance(named: .darkAqua)
                        previewWindow.backgroundColor = ReviewPalette.background
                        previewWindow.contentView = NSHostingView(rootView: RecastRoundTripSheet(model: document.model, draft: draft))
                        proposalSnapshotWindow = previewWindow
                        previewWindow.orderInForSnapshot()
                    }
                }
                captured = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    do {
                        try writeRecastSnapshot(window: self.proposalSnapshotWindow ?? window.attachedSheet ?? window, to: snapshotPath)
                        FileHandle.standardError.write(Data("recast snapshot: titlebar \(WindowTitlebar.audit(window).line)\n".utf8))
                        exit(0)
                    } catch {
                        FileHandle.standardError.write(Data("recast snapshot failed: \(error)\n".utf8)); exit(1)
                    }
                }
            }
        }
        if let url {
            document.model.perform("Opening conversion") { model in
                let state = try await Task.detached(priority: .userInitiated) { try RecastPackage.load(url) }.value
                let answer = try await model.command("inspect", file: state.file)
                let checked = try JSONDecoder().decode(RecastInspection.self, from: Data(answer.utf8))
                try Task.checkCancellation()
                model.install(RecastState(file: checked.document, assets: state.assets))
                if recovering {
                    document.fileURL = nil
                    document.updateChangeCount(.changeDone)
                    try await document.persistBeforeInference()
                    model.notice = "Recovered autosaved conversion. Save it to choose a destination."
                    if let saved = document.autosavedContentsFileURL {
                        HubPerf.log("recast: recovery ready " + saved.path)
                        FileHandle.standardError.write(Data(("recast recovery ready: " + saved.path + "\n").utf8))
                    }
                }
                model.issues = checked.issues
            }
        } else { document.model.start(kind: kind) }
    }
}

@MainActor
private func writeRecastSnapshot(window: NSWindow, to path: String) throws {
    guard let content = window.contentView, let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
        throw recastError("The native window has no renderable surface.")
    }
    content.cacheDisplay(in: content.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]), png.count > 1000 else { throw recastError("PNG rendering failed.") }
    try png.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func runRecast(_ args: [String]) -> Never {
    MainActor.assumeIsolated {
        func value(_ flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        let app = NSApplication.shared
        let delegate = RecastAppDelegate()
        delegate.snapshotPath = value("--snapshot")
        delegate.snapshotProposal = delegate.snapshotPath != nil && value("--snapshot-view") == "proposal"
        delegate.snapshotEvidence = delegate.snapshotPath != nil && value("--snapshot-view") == "evidence"
        delegate.snapshotContradiction = delegate.snapshotPath != nil && value("--snapshot-view") == "contradiction"
        delegate.snapshotBulk = delegate.snapshotPath != nil && value("--snapshot-view") == "bulk"
        delegate.snapshotCorrection = delegate.snapshotPath != nil && value("--snapshot-view") == "correction"
        delegate.snapshotField = value("--snapshot-field")
        delegate.snapshotRecord = value("--snapshot-record")
        delegate.snapshotEvidenceAnchor = delegate.snapshotEvidence ? value("--snapshot-evidence-anchor") : nil
        if delegate.snapshotProposal { delegate.snapshotReadingIDs = value("--snapshot-readings")?.split(separator: ",").map(String.init) }
        delegate.initialSource = value("--source").map { URL(fileURLWithPath: $0) }
        delegate.initialCSV = value("--review-csv").map { URL(fileURLWithPath: $0) }
        delegate.snapshotCSV = delegate.snapshotPath != nil && delegate.initialCSV != nil
        do { RecastConfiguration.toolsPath = try value("--tools") ?? AppToolsOrigin.binaryPath() }
        catch {
            FileHandle.standardError.write(Data("recast: \(error.localizedDescription)\n".utf8)); exit(1)
        }
        RecastConfiguration.initialDirectory = value("--directory").map { URL(fileURLWithPath: $0, isDirectory: true) }
        if delegate.snapshotPath != nil { HubDefaults.isolate() }
        app.setActivationPolicy(delegate.snapshotPath == nil ? .regular : .prohibited)
        app.delegate = delegate
        delegate.installMenu()
        installBrowserURLForwarder()
        if delegate.snapshotPath == nil { installNotificationClicksForWindowFace() }
        delegate.launchConversion = {
            delegate.create(url: (value("--recover") ?? value("--open")).map { URL(fileURLWithPath: $0) },
                kind: value("--kind") ?? "table", recovering: value("--recover") != nil)
        }
        if delegate.snapshotPath == nil && !args.contains("--no-activate") { app.activate(ignoringOtherApps: true) }
        if delegate.snapshotPath != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
                FileHandle.standardError.write(Data("recast: no valid render within 60 seconds\n".utf8)); exit(1)
            }
        }
        HangWatch.start()
        withExtendedLifetime(delegate) { app.run() }
    }
    exit(0)
}
