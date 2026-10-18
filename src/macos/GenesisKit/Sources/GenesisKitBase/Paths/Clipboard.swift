import AppKit
import SwiftUI

// MARK: - Copying

/// The one way a control copies text: the pasteboard, then the `CopyToast` confirmation.
public enum Clipboard {
    /// `what` names the value in the confirmation ("Copied path"); nil says "Copied".
    public static func copy(_ text: String, what: String? = nil) {
        guard !text.isEmpty else {
            KitHost.log("copy \(what ?? "text"): nothing to copy")
            CopyToast.post(title: "Nothing to copy", detail: what.map { "No \($0)" } ?? "", style: .problem)
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        KitHost.log("copy \(what ?? "text") \(text.count) chars")
        // A path under the home folder shows as "~/…": shorter, and the part that says which one stays.
        CopyToast.post(title: what.map { "Copied \($0)" } ?? "Copied", detail: CopyToast.preview(PathDisplay.tilde(text)), style: .copied)
    }
}

/// A small capsule beside the pointer that confirms a copy ("Copied path" and the start of the
/// value), or says why a path did not open. It fades after about 1.2 s. A borderless panel that
/// takes no click and never becomes key, so it shows over any window, popover or web view and
/// nothing under it changes. Not a notification banner, and never a sound.
public enum CopyToast {
    public enum Style {
        case copied
        case problem
    }

    /// Callable from any thread; the panel is shown on the main thread.
    public static func post(title: String, detail: String, style: Style) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { CopyToastPanel.shared.show(title: title, detail: detail, style: style) }
        } else {
            DispatchQueue.main.async {
                MainActor.assumeIsolated { CopyToastPanel.shared.show(title: title, detail: detail, style: style) }
            }
        }
    }

    /// One short line of what was copied: a multi-line text as its line count, a long line with
    /// its middle cut (a path keeps its start and its file name).
    public static func preview(_ text: String, limit: Int = 56) -> String {
        let lines = text.split(whereSeparator: \.isNewline)
        if lines.count > 1 {
            return "\(lines.count) lines"
        }

        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.count > limit else {
            return line
        }

        let half = (limit - 1) / 2
        return "\(line.prefix(half))…\(line.suffix(half))"
    }

    /// Where the capsule goes: above and right of the pointer, inside the visible screen.
    public static func origin(pointer: CGPoint, size: CGSize, screen: CGRect) -> CGPoint {
        var origin = CGPoint(x: pointer.x + 14, y: pointer.y + 10)
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        origin.y = min(max(origin.y, screen.minY + 4), screen.maxY - size.height - 4)
        return origin
    }
}

@MainActor
private final class CopyToastPanel {
    static let shared = CopyToastPanel()

    private let panel: NSPanel
    private let host: NSHostingView<CopyToastView>
    private var generation = 0

    private init() {
        host = NSHostingView(rootView: CopyToastView(title: "", detail: "", style: .copied))
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .canJoinAllSpaces]
        panel.contentView = host
    }

    func show(title: String, detail: String, style: CopyToast.Style) {
        generation += 1
        let current = generation
        host.rootView = CopyToastView(title: title, detail: detail, style: style)
        let size = host.fittingSize
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(pointer) } ?? NSScreen.main
        let origin = CopyToast.origin(pointer: pointer, size: size, screen: screen?.visibleFrame ?? CGRect(origin: .zero, size: size))
        panel.setFrame(CGRect(origin: origin, size: size), display: true)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        }
        let hold = style == .copied ? 0.9 : 2.2
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            MainActor.assumeIsolated { self?.fade(current) }
        }
    }

    private func fade(_ shown: Int) {
        guard shown == generation else {
            return
        }

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, shown == self.generation else { return }
                self.panel.orderOut(nil)
            }
        }
    }
}

package struct CopyToastView: View {
    package let title: String
    package let detail: String
    package let style: CopyToast.Style

    package var body: some View {
        HStack(spacing: 6) {
            Image(systemName: style == .copied ? "checkmark" : "exclamationmark.circle")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(style == .copied ? KitPalette.added : KitPalette.modified)
            Text(verbatim: title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(Color.white.opacity(0.92))
            if !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(KitPalette.dim)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color(white: 0.13).opacity(0.96)))
        .overlay(Capsule().stroke(Color.white.opacity(0.12)))
        .padding(6)
        .fixedSize()
        .environment(\.colorScheme, .dark)
    }
}

