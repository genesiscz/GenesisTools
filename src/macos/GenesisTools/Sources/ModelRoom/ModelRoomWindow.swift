import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
enum ModelRoomConfiguration {
    static var toolsPath = ToolsBridge.defaultBinaryPath()
    static var initialDirectory: URL?
}

@MainActor
final class ModelRoomDocument: NSDocument {
    let model: ModelRoomModel
    var onClose: (() -> Void)?
    override init() {
        model = ModelRoomModel(toolsPath: ModelRoomConfiguration.toolsPath)
        super.init()
        model.owner = self
        hasUndoManager = true
        undoManager = UndoManager()
        fileType = "public.json"
    }
    override class var autosavesInPlace: Bool { true }
    override class var readableTypes: [String] { ["public.json"] }
    override class var writableTypes: [String] { ["public.json"] }
    override var fileURL: URL? {
        didSet { model.objectWillChange.send() }
    }

    override func updateChangeCount(_ change: NSDocument.ChangeType) {
        super.updateChangeCount(change)
        model.objectWillChange.send()
    }

    override func makeWindowControllers() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1460, height: 920), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Model Room · \(model.file?.title ?? "Untitled")"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = ReviewPalette.background
        window.minSize = NSSize(width: 780, height: 600)
        window.contentView = NSHostingView(rootView: ModelRoomView(model: model).defaultAppStorage(HubDefaults.store).titlebarZone())
        window.center()
        addWindowController(NSWindowController(window: window))
    }

    override func data(ofType typeName: String) throws -> Data {
        guard let file = model.file else {
            throw NSError(domain: "ModelRoom", code: 2, userInfo: [NSLocalizedDescriptionKey: "The model has not finished opening."])
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(file)
    }

    override func read(from data: Data, ofType typeName: String) throws {
        guard data.count <= 16 * 1024 * 1024 else {
            throw NSError(domain: "ModelRoom", code: 3, userInfo: [NSLocalizedDescriptionKey: "The document exceeds 16 MiB."])
        }
        let file = try JSONDecoder().decode(ModelRoomFile.self, from: data)
        try file.validateForEditing()
        let publish: @MainActor () -> Void = {
            self.model.file = file
            self.model.selectedScenario = ""
            self.model.normalizeSelection()
            self.model.selectedQuantity = file.presentation.outputs.first ?? file.quantities.first?.id ?? ""
            self.displayName = file.title
        }
        if Thread.isMainThread {
            MainActor.assumeIsolated { publish() }
        } else {
            DispatchQueue.main.sync { publish() }
        }
    }

    override func prepareSavePanel(_ savePanel: NSSavePanel) -> Bool {
        savePanel.allowedContentTypes = [.json]
        if fileURL == nil, let directory = ModelRoomConfiguration.initialDirectory { savePanel.directoryURL = directory }
        savePanel.nameFieldStringValue = (model.file?.title ?? "Untitled") + ".modelroom.json"
        return true
    }

    @objc func exportHTML(_ sender: Any?) { model.exportDocument(format: "html") }
    @objc func exportResults(_ sender: Any?) { model.exportDocument(format: "results") }
    @objc func exportAssumptions(_ sender: Any?) { model.exportDocument(format: "assumptions") }
    override func close() { model.stop(); onClose?(); super.close() }
}

@MainActor
private final class ModelRoomAppDelegate: NSObject, NSApplicationDelegate {
    var documents: [ModelRoomDocument] = []
    var initialDataURL: URL?
    var snapshotPath: String?
    var snapshotMode = ModelRoomMode.build
    var snapshotTick = 6
    var snapshotWidth: CGFloat = 1460
    var captured = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    func installMenu() {
        AppMainMenu.install()
        let file = NSMenu(title: "File")
        for (title, action, key) in [
            ("New Support Model", #selector(newSupport(_:)), "n"),
            ("New Classroom Model", #selector(newClassroom(_:)), ""),
            ("New Project Budget", #selector(newBudget(_:)), ""),
            ("Open Model…", #selector(openModel(_:)), "o")
        ] {
            let item = file.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
        }
        file.addItem(.separator())
        file.addItem(withTitle: "Save", action: #selector(NSDocument.save(_:)), keyEquivalent: "s")
        file.addItem(withTitle: "Save As…", action: #selector(NSDocument.saveAs(_:)), keyEquivalent: "s").keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        file.addItem(withTitle: "Export Interactive HTML…", action: #selector(ModelRoomDocument.exportHTML(_:)), keyEquivalent: "e")
        file.addItem(withTitle: "Export Results CSV…", action: #selector(ModelRoomDocument.exportResults(_:)), keyEquivalent: "")
        file.addItem(withTitle: "Export Assumptions CSV…", action: #selector(ModelRoomDocument.exportAssumptions(_:)), keyEquivalent: "")
        file.addItem(.separator())
        file.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let item = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        item.submenu = file
        NSApp.mainMenu?.insertItem(item, at: 1)
    }

    @objc func newSupport(_ sender: Any?) { create(example: "support") }
    @objc func newClassroom(_ sender: Any?) { create(example: "classroom") }
    @objc func newBudget(_ sender: Any?) { create(example: "budget") }
    @objc func openModel(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = true
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            for url in panel.urls { self?.create(url: url) }
        }
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        // AppKit also forwards existing paths from custom launch arguments, including the tools executable.
        guard snapshotPath == nil else { sender.reply(toOpenOrPrint: .cancel); return }
        let modelFiles = filenames.filter { $0.hasSuffix(".json") }
        for filename in modelFiles {
            let url = URL(fileURLWithPath: filename).standardizedFileURL
            if !documents.contains(where: { $0.fileURL?.standardizedFileURL == url }) { create(url: url) }
        }
        sender.reply(toOpenOrPrint: modelFiles.isEmpty ? .cancel : .success)
    }

    func create(example: String = "support", url: URL? = nil) {
        let document = ModelRoomDocument()
        do {
            if let url {
                try document.read(from: url, ofType: "public.json")
                document.fileURL = url
            }
            document.makeWindowControllers()
            NSDocumentController.shared.addDocument(document)
            documents.append(document)
            document.onClose = { [weak self, weak document] in
                guard let document else { return }
                self?.documents.removeAll { $0 === document }
            }
            document.model.mode = snapshotMode
            document.model.tick = snapshotTick
            if snapshotPath == nil, let source = initialDataURL {
                initialDataURL = nil
                document.model.onEvaluated = { [weak model = document.model] in
                    guard let model else { return }
                    model.onEvaluated = nil
                    model.previewTable(url: source, delimiter: source.pathExtension == "tsv" ? "tab" : "comma")
                }
            }
            guard let window = document.windowControllers.first?.window else { return }
            if let snapshotPath {
                window.setContentSize(NSSize(width: snapshotWidth, height: 920))
                document.model.onEvaluated = { [weak self, weak window] in
                    guard let self, let window, !captured else { return }
                    captured = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        do {
                            try writeModelRoomSnapshot(window: window, to: snapshotPath)
                            FileHandle.standardError.write(Data("model-room snapshot: titlebar \(WindowTitlebar.audit(window).line)\n".utf8))
                            exit(0)
                        } catch {
                            FileHandle.standardError.write(Data("model-room snapshot failed: \(error)\n".utf8))
                            exit(1)
                        }
                    }
                }
                window.orderInForSnapshot()
            } else {
                document.showWindows()
                window.makeKeyAndOrderFront(nil)
            }
            if url == nil { document.model.loadExample(example) }
            else { document.model.evaluate(immediate: true) }
        } catch {
            if snapshotPath != nil {
                FileHandle.standardError.write(Data("model-room: \(error)\n".utf8))
                exit(1)
            }
            NSApp.presentError(error)
        }
    }
}

@MainActor
private func writeModelRoomSnapshot(window: NSWindow, to path: String) throws {
    guard let content = window.contentView, let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
        throw NSError(domain: "ModelRoom", code: 5, userInfo: [NSLocalizedDescriptionKey: "The native view has no renderable surface."])
    }
    content.cacheDisplay(in: content.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]), png.count > 1000 else {
        throw NSError(domain: "ModelRoom", code: 6, userInfo: [NSLocalizedDescriptionKey: "PNG rendering failed."])
    }
    try png.write(to: URL(fileURLWithPath: path), options: .atomic)
}

func runModelRoom(_ args: [String]) -> Never {
    MainActor.assumeIsolated {
        func value(_ flag: String) -> String? {
            guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        let app = NSApplication.shared
        let delegate = ModelRoomAppDelegate()
        delegate.snapshotPath = value("--snapshot")
        delegate.initialDataURL = value("--data").map { URL(fileURLWithPath: $0) }
        delegate.snapshotMode = ModelRoomMode(rawValue: value("--mode")?.capitalized ?? "Build") ?? .build
        delegate.snapshotTick = Int(value("--tick") ?? "6") ?? 6
        delegate.snapshotWidth = CGFloat(Double(value("--width") ?? "1460") ?? 1460)
        do {
            ModelRoomConfiguration.toolsPath = try value("--tools") ?? AppToolsOrigin.binaryPath()
        } catch {
            FileHandle.standardError.write(Data("model-room: \(error.localizedDescription)\n".utf8))
            if delegate.snapshotPath == nil { app.presentError(error) }
            exit(1)
        }
        if let directory = value("--directory") { ModelRoomConfiguration.initialDirectory = URL(fileURLWithPath: directory, isDirectory: true) }
        if delegate.snapshotPath != nil { HubDefaults.isolate() }
        app.setActivationPolicy(delegate.snapshotPath == nil ? .regular : .prohibited)
        app.delegate = delegate
        delegate.installMenu()
        installBrowserURLForwarder()
        if delegate.snapshotPath == nil { installNotificationClicksForWindowFace() }
        delegate.create(example: value("--example") ?? "support", url: value("--open").map { URL(fileURLWithPath: $0) })
        if delegate.snapshotPath == nil && !args.contains("--no-activate") { app.activate(ignoringOtherApps: true) }
        if delegate.snapshotPath != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 40) {
                FileHandle.standardError.write(Data("model-room: no valid render within 40 seconds\n".utf8))
                exit(1)
            }
        }
        HangWatch.start()
        withExtendedLifetime(delegate) { app.run() }
    }
    exit(0)
}
