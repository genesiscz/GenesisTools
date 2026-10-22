import AppKit
import Foundation
import GenesisKitBase
import SwiftUI

/// One "Allow GenesisTools to find devices on local networks?" prompt, as `tools macos permissions local-network
/// --json` describes it. The system dialog cannot say which program asked: its text is the fixed
/// `NSLocalNetworkUsageDescription`, and every `tools` program runs inside the same launcher.
struct LocalNetworkPrompt: Decodable, Equatable, Identifiable {
    struct Program: Decodable, Equatable {
        let started: String
        let command: String
        let cwd: String?
        let children: [String]
    }

    let at: String
    let pid: Int
    let executable: String
    let retiredAt: String?
    let process: Program?

    var id: String { "\(pid) \(at)" }
}

struct LocalNetworkPromptList: Decodable {
    let prompts: [LocalNetworkPrompt]
}

/// The link relay follows nehelper's log, which names the responsible pid one line before the dialog opens, and shows
/// a panel beside the dialog that says which program asked. The panel closes when the dialog is gone.
@MainActor
enum LocalNetworkWatch {
    private static let predicate = #"process == "nehelper" AND eventMessage CONTAINS "allowing a new prompt""#
    private static let restartSeconds = 15.0
    private static var stream: Process?
    private static var panel: LocalNetworkPanel?
    private nonisolated(unsafe) static var streamPid: pid_t = 0
    private static var reapsOnExit = false
    /// The `--local-network-panel` face ends with its panel.
    static var onPanelClosed: (() -> Void)?

    /// The pid in nehelper's `Found new path <executable> for PID <pid>, allowing a new prompt` line, when the
    /// executable is a GenesisTools launcher (installed or a retired build). nehelper logs every app's prompts, and
    /// another app's dialog names that app itself.
    nonisolated static func promptPid(inLogLine line: String) -> Int? {
        guard let marker = line.range(of: ", allowing a new prompt"),
              let pidStart = line.range(of: " for PID ", options: .backwards, range: line.startIndex..<marker.lowerBound),
              let pathStart = line.range(of: "Found new path ", range: line.startIndex..<pidStart.lowerBound),
              line[pathStart.upperBound..<pidStart.lowerBound].hasSuffix("/GenesisTools.app/Contents/MacOS/GenesisTools")
        else { return nil }
        return Int(line[pidStart.upperBound..<marker.lowerBound])
    }

    static func start() {
        guard stream == nil else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        process.arguments = ["stream", "--style", "compact", "--level", "info", "--predicate", predicate]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        let lines = LineSplitter { line in
            guard let pid = promptPid(inLogLine: line) else { return }
            Task { @MainActor in await announce(pid: pid) }
        }
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            lines.feed(data)
        }
        process.terminationHandler = { ended in
            let status = ended.terminationStatus
            Task { @MainActor in
                stream = nil
                HubPerf.log("localNetwork: log stream ended (status \(status)); again in \(Int(restartSeconds)) s")
                DispatchQueue.main.asyncAfter(deadline: .now() + restartSeconds) { MainActor.assumeIsolated { start() } }
            }
        }
        do {
            try process.run()
        } catch {
            HubPerf.log("localNetwork: log stream did not start: \(error.localizedDescription)")
            return
        }
        stream = process
        streamPid = process.processIdentifier
        if !reapsOnExit {
            reapsOnExit = true
            // `log stream` would outlive the relay until its next line found the pipe closed.
            atexit { if LocalNetworkWatch.streamPid > 0 { kill(LocalNetworkWatch.streamPid, SIGTERM) } }
        }
        HubPerf.log("localNetwork: following nehelper prompts (log stream pid \(process.processIdentifier))")
    }

    /// Asks `tools` who the pid is; the prompt line comes before the dialog, so the program usually still runs.
    private static func announce(pid: Int) async {
        HubPerf.log("localNetwork: prompt for pid \(pid)")
        var prompt: LocalNetworkPrompt?
        do {
            let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath()).run(
                subcommand: "macos", args: ["permissions", "local-network", "--since", "5m", "--json"], timeoutSeconds: 60)
            let list = try JSONDecoder().decode(LocalNetworkPromptList.self, from: Data(result.stdout.utf8))
            prompt = list.prompts.last { $0.pid == pid }
        } catch {
            HubPerf.log("localNetwork: could not describe pid \(pid): \(error)")
        }
        show(prompt ?? LocalNetworkPrompt(at: "", pid: pid, executable: "", retiredAt: nil, process: nil))
    }

    static func show(_ prompt: LocalNetworkPrompt) {
        if let panel, panel.isVisible {
            panel.add(prompt)
            return
        }
        let created = LocalNetworkPanel(prompts: [prompt]) {
            panel = nil
            onPanelClosed?()
        }
        panel = created
        created.present()
    }
}

/// Splits a byte stream into lines on the reading thread.
private final class LineSplitter: @unchecked Sendable {
    private var buffer = Data()
    private let lock = NSLock()
    private let onLine: (String) -> Void

    init(onLine: @escaping (String) -> Void) {
        self.onLine = onLine
    }

    func feed(_ data: Data) {
        lock.lock()
        buffer.append(data)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        lock.unlock()
        lines.forEach(onLine)
    }
}

@MainActor
final class LocalNetworkPanelModel: ObservableObject {
    @Published var prompts: [LocalNetworkPrompt]

    init(prompts: [LocalNetworkPrompt]) {
        self.prompts = prompts
    }
}

/// A card beside the system dialog. It never takes the keyboard, so the dialog keeps its Allow / Don't Allow keys.
final class LocalNetworkPanel: NSPanel {
    static let width: CGFloat = 400
    private let model: LocalNetworkPanelModel
    private let closed: () -> Void
    private var watch: Timer?
    private var dialogSeen = false
    private var missingTicks = 0

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(prompts: [LocalNetworkPrompt], closed: @escaping () -> Void) {
        model = LocalNetworkPanelModel(prompts: prompts)
        self.closed = closed
        super.init(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 200),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        let model = model
        let host = NSHostingView(rootView: LocalNetworkPanelView(model: model) { [weak self] in self?.dismiss() })
        contentView = host
    }

    func add(_ prompt: LocalNetworkPrompt) {
        guard !model.prompts.contains(prompt) else { return }
        model.prompts.append(prompt)
        place()
    }

    func present() {
        place()
        orderFrontRegardless()
        watch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.followDialog() }
        }
    }

    func dismiss() {
        watch?.invalidate()
        watch = nil
        orderOut(nil)
        closed()
    }

    /// Right of the dialog, or under it when the right side has no room; top centre of the screen without one.
    private func place() {
        if let fitting = contentView?.fittingSize {
            setContentSize(NSSize(width: Self.width, height: fitting.height))
        }
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        guard let dialog = Self.dialogFrame() else {
            setFrameOrigin(NSPoint(x: visible.midX - frame.width / 2, y: visible.maxY - frame.height - 80))
            return
        }
        let right = NSPoint(x: dialog.maxX + 14, y: dialog.maxY - frame.height)
        if right.x + frame.width <= visible.maxX {
            setFrameOrigin(NSPoint(x: right.x, y: max(visible.minY, right.y)))
        } else {
            setFrameOrigin(NSPoint(x: dialog.midX - frame.width / 2, y: max(visible.minY, dialog.minY - frame.height - 14)))
        }
    }

    private func followDialog() {
        if Self.dialogFrame() != nil {
            dialogSeen = true
            missingTicks = 0
            place()
            return
        }
        missingTicks += 1
        // Gone after it was seen: answered. Never seen: the dialog closed before the panel came, or it was elsewhere.
        if (dialogSeen && missingTicks >= 2) || (!dialogSeen && missingTicks >= 20) {
            dismiss()
        }
    }

    /// The `UserNotificationCenter` window, the process that draws the Local Network dialog (unified log, 2026-10-22
    /// 16:33:02), in Cocoa screen coordinates.
    static func dialogFrame() -> NSRect? {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let info = list.first(where: { ($0[kCGWindowOwnerName as String] as? String) == "UserNotificationCenter" }),
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 100,
              let primary = NSScreen.screens.first
        else { return nil }
        return NSRect(x: rect.minX, y: primary.frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }
}

struct LocalNetworkPanelView: View {
    @ObservedObject var model: LocalNetworkPanelModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: "network")
                    .foregroundStyle(.orange)
                Text(model.prompts.count == 1 ? "This program asks for local network access"
                                               : "\(Plural.count(model.prompts.count, "program")) ask for local network access")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                // The host links only GenesisKitBase, which has no IconButton or instantTooltip.
                .help("Close")
            }
            ForEach(model.prompts) { prompt in
                LocalNetworkPromptRow(prompt: prompt)
            }
            Text("Each build asks once. Allow lets this build reach devices on your network; Don't Allow blocks only this build.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: LocalNetworkPanel.width, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.97))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12))
        )
    }
}

struct LocalNetworkPromptRow: View {
    let prompt: LocalNetworkPrompt

    private var build: String {
        guard let retired = prompt.retiredAt.flatMap(Self.parse) else { return "the installed build" }
        return "an old build, retired at \(Self.clock.string(from: retired)) by a rebuild"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(verbatim: prompt.process.map { Self.short($0.command) } ?? "pid \(prompt.pid) (it has already exited)")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .lineLimit(3)
                .textSelection(.enabled)
            if let cwd = prompt.process?.cwd {
                label("folder", cwd)
            }
            if let started = prompt.process.flatMap({ Self.parse($0.started) }) {
                label("started", Self.clock.string(from: started))
            }
            label("runs on", build)
            label("pid", "\(prompt.pid)")
            Button(action: copy) {
                Label("Copy details", systemImage: "doc.on.doc")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
    }

    private func label(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(name)
                .foregroundStyle(.secondary)
                .frame(width: 52, alignment: .leading)
            Text(verbatim: value)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .font(.system(size: 11))
    }

    private func copy() {
        var lines = ["Local network prompt at \(prompt.at) for pid \(prompt.pid)", "executable: \(prompt.executable)"]
        if let process = prompt.process {
            lines += ["command: \(process.command)", "folder: \(process.cwd ?? "?")", "started: \(process.started)"]
            lines += process.children.map { "child: \($0)" }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
    }

    /// `gt-cc /…/GenesisTools/src/cc/index.ts run foltyn` reads as `cc run foltyn`.
    static func short(_ command: String) -> String {
        let words = command.split(separator: " ").map(String.init)
        guard let first = words.first, first.hasPrefix("gt-") || first.hasSuffix("/bun") else { return command }
        if let entry = words.firstIndex(where: { $0.contains("/src/") && ($0.hasSuffix("/index.ts") || $0.hasSuffix("/index.tsx")) }) {
            let tool = URL(fileURLWithPath: words[entry]).deletingLastPathComponent().lastPathComponent
            return ([tool] + words[(entry + 1)...]).joined(separator: " ")
        }
        return command
    }

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static func parse(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// `GenesisTools --local-network-panel --payload <json> [--snapshot <png>]`: the panel for a saved
/// `tools macos permissions local-network --json`, on screen or rendered to a PNG without a window.
func runLocalNetworkPanel(_ args: [String]) -> Never {
    let value = { (flag: String) in args.firstIndex(of: flag).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } }
    guard let payload = value("--payload"),
          let list = try? JSONDecoder().decode(LocalNetworkPromptList.self, from: Data(payload.utf8)), !list.prompts.isEmpty
    else {
        FileHandle.standardError.write(Data("--local-network-panel needs --payload with the JSON of tools macos permissions local-network --json\n".utf8))
        exit(64)
    }
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        if let snapshot = value("--snapshot") {
            app.setActivationPolicy(.prohibited)
            let renderer = ImageRenderer(content: LocalNetworkPanelView(model: LocalNetworkPanelModel(prompts: list.prompts)) {}
                .environment(\.colorScheme, .dark))
            renderer.scale = 2
            guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { exit(1) }
            exit((try? png.write(to: URL(fileURLWithPath: snapshot))) == nil ? 1 : 0)
        }
        app.setActivationPolicy(.accessory)
        LocalNetworkWatch.onPanelClosed = { exit(0) }
        for prompt in list.prompts {
            LocalNetworkWatch.show(prompt)
        }
        app.run()
    }
    exit(0)
}
