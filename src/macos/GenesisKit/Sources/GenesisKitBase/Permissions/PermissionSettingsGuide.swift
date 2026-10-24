import AppKit
import SwiftUI

/// A small floating helper over System Settings while a grant is turned on there: this app's icon and one line,
/// "Drag GenesisTools into the list" for the lists that take a dragged app (Accessibility, Input Monitoring, Screen
/// Recording, Full Disk Access), "Turn on GenesisTools in the list" for the others. It sits at the bottom of the
/// Privacy pane, shows only while System Settings is the active app, and goes away when the grant arrives, the dialog
/// closes, System Settings quits, or the person closes it. The `permissions.settingsGuide` default turns it off.
@MainActor
public final class PermissionSettingsGuide {
    public static let shared = PermissionSettingsGuide()

    /// The preference: true (the default) shows the helper whenever the app opens a Privacy pane.
    public static let enabledKey = "permissions.settingsGuide"
    static let settingsBundleID = "com.apple.systempreferences"

    public static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    private var panel: NSPanel?
    private(set) var kind: PermissionKind?
    private var tick: Timer?
    private var shownAt = Date.distantPast
    /// The helper gives up on its own after this long, as the permission dialog stops waiting.
    private let lifetime: TimeInterval = 600

    init() {}

    /// Shows the helper for `kind` (when the preference is on and the grant has a System Settings list).
    public func show(for kind: PermissionKind, appURL: URL = Bundle.main.bundleURL) {
        guard Self.isEnabled else { return }
        close()
        self.kind = kind
        shownAt = Date()
        let panel = makePanel(kind: kind, appURL: appURL)
        self.panel = panel
        // Twice a second: System Settings opens with an animation and can be moved; the helper follows it and hides
        // while another app is in front. It runs only while the helper exists.
        tick = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.follow() }
        }
        follow()
        KitHost.log("permission \(kind.rawValue) settings guide shown")
    }

    /// Closes the helper when it is showing for `kind` (nil: whatever it shows).
    public func dismiss(_ kind: PermissionKind? = nil) {
        guard panel != nil, kind == nil || kind == self.kind else { return }
        close()
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    private func close() {
        tick?.invalidate()
        tick = nil
        panel?.orderOut(nil)
        panel?.close()
        panel = nil
        kind = nil
    }

    private func follow() {
        guard let panel else { return }
        guard Date().timeIntervalSince(shownAt) < lifetime else { return close() }
        let settings = NSRunningApplication.runningApplications(withBundleIdentifier: Self.settingsBundleID).first
        guard let settings else {
            // System Settings quit (or never opened): nothing left to point at.
            if Date().timeIntervalSince(shownAt) > 5 { close() }
            return
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == settings.processIdentifier,
              let window = Self.settingsWindow(pid: settings.processIdentifier)
        else {
            panel.orderOut(nil)
            return
        }
        let size = panel.frame.size
        let origin = Self.origin(size: size, settingsWindow: window)
        if panel.frame.origin != origin { panel.setFrameOrigin(origin) }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    /// Bottom of the Privacy pane's list: the right part of the window, past the sidebar, a little above the edge.
    static func origin(size: CGSize, settingsWindow window: CGRect) -> CGPoint {
        let sidebar = min(260, window.width * 0.3)
        let paneMid = window.minX + sidebar + (window.width - sidebar) / 2
        return CGPoint(x: (paneMid - size.width / 2).rounded(), y: (window.minY + 28).rounded())
    }

    /// System Settings' largest normal window, in Cocoa screen points.
    static func settingsWindow(pid: pid_t) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return nil }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let frames: [CGRect] = list.compactMap { info in
            guard (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
                  info[kCGWindowLayer as String] as? Int == 0,
                  let bounds = info[kCGWindowBounds as String] as? [String: CGFloat],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  rect.width > 200, rect.height > 200
            else { return nil }
            return CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
        }
        return frames.max { $0.width * $0.height < $1.width * $1.height }
    }

    private func makePanel(kind: PermissionKind, appURL: URL) -> NSPanel {
        let appName = FileManager.default.displayName(atPath: appURL.path)
            .replacingOccurrences(of: ".app", with: "")
        let view = PermissionGuideView(kind: kind, appName: appName, appURL: appURL,
                                       onClose: { [weak self] in self?.close() })
        let host = GuideHostingView(rootView: view)
        let size = host.fittingSize
        let panel = PermissionGuidePanel(contentRect: CGRect(origin: .zero, size: size),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Drag \(appName) into the list"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = host
        panel.setAccessibilityIdentifier("permission-settings-guide")
        return panel
    }
}

/// Takes clicks and drags without activating this app, so System Settings stays the active app under the drop.
private final class PermissionGuidePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The panel never becomes key, so its first click must act (the close button) instead of only focusing it.
private final class GuideHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

public extension PermissionKind {
    /// System Settings' list for this grant has a "+" and takes an app dropped on it.
    var addsByDrag: Bool {
        switch self {
        case .accessibility, .inputMonitoring, .screenRecording, .fullDiskAccess: return true
        default: return false
        }
    }
}

struct PermissionGuideView: View {
    let kind: PermissionKind
    let appName: String
    let appURL: URL
    let onClose: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Color.accentColor.opacity(0.55), .clear], center: .center,
                                         startRadius: 4, endRadius: 62))
                    .frame(width: 124, height: 124)
                    .accessibilityHidden(true)
                AppDragSource(appURL: appURL, draggable: kind.addsByDrag)
                    .frame(width: 72, height: 72)
                    .accessibilityLabel(kind.addsByDrag ? "\(appName), drag into the list" : appName)
            }
            .frame(width: 124, height: 96)
            Text(kind.addsByDrag ? "Drag \(appName)\ninto the list" : "Turn on \(appName)\nin the list")
                .font(.system(size: 13, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.6), radius: 3)
                .fixedSize()
            Text(kind.title).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.7))
        }
        .padding(.horizontal, 18)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(hovering ? 0.95 : 0.6))
                    .frame(width: 18, height: 18)
                    .background(.white.opacity(hovering ? 0.22 : 0.1), in: Circle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .help("Close this helper")
            .accessibilityLabel("Close")
            .padding(6)
        }
        .padding(4)
        .environment(\.colorScheme, .dark)
    }
}

/// The app's icon. Where the list takes a dropped app, a drag from it carries the app bundle's file URL, which is
/// what dragging the app from Finder carries.
private struct AppDragSource: NSViewRepresentable {
    let appURL: URL
    let draggable: Bool

    func makeNSView(context: Context) -> AppDragSourceView {
        AppDragSourceView(appURL: appURL, draggable: draggable)
    }

    func updateNSView(_ view: AppDragSourceView, context: Context) {}
}

final class AppDragSourceView: NSView, NSDraggingSource {
    let appURL: URL
    let draggable: Bool
    private let icon: NSImage

    init(appURL: URL, draggable: Bool) {
        self.appURL = appURL
        self.draggable = draggable
        icon = NSWorkspace.shared.icon(forFile: appURL.path)
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        if draggable { addCursorRect(bounds, cursor: .openHand) }
    }

    override func draw(_ dirtyRect: NSRect) {
        icon.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
    }

    override func mouseDragged(with event: NSEvent) {
        guard draggable else { return }
        let item = NSDraggingItem(pasteboardWriter: appURL as NSURL)
        item.setDraggingFrame(bounds, contents: icon)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession,
                         sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .generic, .link] : []
    }
}
