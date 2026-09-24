import AppKit
import Foundation

struct RouteToastChoice {
    var enabled = true
    var seconds = 5.0
    var title: String?
    /// The route's `name` from the config: a human headline in place of the raw parameter.
    var name: String?
}

enum RouteToast {
    static func choice(routeIndex: Int?, fallbackTitle: String) -> RouteToastChoice {
        var choice = RouteToastChoice()
        guard let data = try? loadConfigData(),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            choice.title = fallbackTitle
            return choice
        }

        apply(root["toast"], to: &choice)

        if let index = routeIndex, let routes = root["routes"] as? [Any], index < routes.count,
           let route = routes[index] as? [String: Any] {
            if let name = route["name"] as? String, !name.isEmpty {
                choice.name = name
            }

            apply(route["toast"], to: &choice)
            if let action = route["action"] as? [String: Any] {
                apply(action["toast"], to: &choice)
            }
        }

        if choice.title == nil {
            choice.title = fallbackTitle
        }

        return choice
    }

    static func show(kicker: String, headline: String, detail: String, seconds: Double, done: @escaping () -> Void) -> RouteToastCard {
        let card = RouteToastCard(kicker: kicker, headline: headline, detail: detail, seconds: seconds, done: done)
        card.present()
        return card
    }

    private static func apply(_ value: Any?, to choice: inout RouteToastChoice) {
        if value is Bool, (value as? Bool) == false {
            choice.enabled = false
            return
        }

        guard let object = value as? [String: Any] else { return }

        if let enabled = object["enabled"] as? Bool {
            choice.enabled = enabled
        }

        if let seconds = object["seconds"] as? Double {
            choice.seconds = seconds
        } else if let seconds = object["seconds"] as? Int {
            choice.seconds = Double(seconds)
        }

        if let title = object["title"] as? String, !title.isEmpty {
            choice.title = title
        }
    }
}

final class RouteToastCard: NSPanel {
    private let body: ToastBody
    private let seconds: Double
    private let done: () -> Void
    private var dismissed = false
    private var restingOrigin = NSPoint.zero

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(kicker: String, headline: String, detail: String, seconds: Double, done: @escaping () -> Void) {
        self.seconds = seconds
        self.done = done
        body = ToastBody(kicker: kicker, headline: headline, detail: detail)
        let size = body.preferredSize
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        animationBehavior = .none
        becomesKeyOnlyIfNeeded = false
        contentView = body
        alphaValue = 0
        placeInTheMiddle()
        restingOrigin = frame.origin
    }

    func present() {
        let resting = restingOrigin
        setFrameOrigin(NSPoint(x: resting.x, y: resting.y - 18))
        orderFrontRegardless()
        NSApp.setActivationPolicy(.accessory)
        NSApp.deactivate()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.42
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animator().alphaValue = 1
            animator().setFrameOrigin(resting)
        }
    }

    /// The card keeps its size: a new line replaces the status line instead of growing it.
    func append(_ line: String) {
        body.append(line)
    }

    override func mouseDown(with event: NSEvent) {
        fadeOut()
    }

    func fadeOut() {
        guard !dismissed else { return }
        dismissed = true
        let away = NSPoint(x: restingOrigin.x, y: frame.origin.y + 10)
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.55
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            animator().alphaValue = 0
            animator().setFrameOrigin(away)
        }, completionHandler: { [done] in
            self.orderOut(nil)
            done()
        })
    }

    func holdThenFade() {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.fadeOut()
        }
    }

    private func placeInTheMiddle() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let size = frame.size
        setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
    }
}

/// Logo on the left, four short lines on the right, one fixed size. Long values truncate
/// (hover shows the whole status line) rather than resizing the card.
private final class ToastBody: NSView {
    static let size = NSSize(width: 460, height: 96)

    private let statusField = NSTextField(labelWithString: "")

    var preferredSize: NSSize { Self.size }

    init(kicker: String, headline: String, detail: String) {
        super.init(frame: NSRect(origin: .zero, size: Self.size))
        wantsLayer = true
        layer?.backgroundColor = NSColor(srgbRed: 0.09, green: 0.09, blue: 0.09, alpha: 0.96).cgColor
        layer?.cornerRadius = 20
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(srgbRed: 0.73, green: 0.58, blue: 0.32, alpha: 0.55).cgColor

        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        let kickerField = NSTextField(labelWithAttributedString: Self.kickerLine(kicker))
        kickerField.lineBreakMode = .byTruncatingTail

        let headlineField = NSTextField(labelWithString: headline)
        headlineField.font = .systemFont(ofSize: 17, weight: .semibold)
        headlineField.textColor = NSColor(white: 0.96, alpha: 1)
        headlineField.lineBreakMode = .byTruncatingTail
        headlineField.maximumNumberOfLines = 1

        let detailLine = detail.split(separator: "\n", omittingEmptySubsequences: true).joined(separator: " · ")
        let detailField = NSTextField(labelWithString: detailLine)
        Self.styleMono(detailField, color: NSColor(white: 0.58, alpha: 1))
        detailField.lineBreakMode = .byTruncatingMiddle
        detailField.toolTip = detailLine
        detailField.isHidden = detailLine.isEmpty

        Self.styleMono(statusField, color: NSColor(white: 0.92, alpha: 1))
        statusField.isHidden = true

        let fields = [kickerField, headlineField, detailField, statusField]
        let text = NSStackView(views: fields)
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 3
        text.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        addSubview(text)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 52),
            icon.heightAnchor.constraint(equalToConstant: 52),
            text.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 14),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            text.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])

        for field in fields {
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            field.widthAnchor.constraint(lessThanOrEqualTo: text.widthAnchor).isActive = true
        }
    }

    required init?(coder: NSCoder) {
        nil
    }

    func append(_ line: String) {
        let flat = line.replacingOccurrences(of: "\n", with: " ")
        statusField.stringValue = flat
        statusField.toolTip = flat
        statusField.isHidden = false
    }

    /// `GENESIS TOOLS · RUNNING` on one small line.
    private static func kickerLine(_ kicker: String) -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        let line = NSMutableAttributedString(string: "GENESIS TOOLS", attributes: [
            .font: font,
            .kern: 0.8,
            .foregroundColor: NSColor(srgbRed: 0.96, green: 0.78, blue: 0.45, alpha: 0.75),
        ])
        line.append(NSAttributedString(string: "  ·  ", attributes: [
            .font: font,
            .foregroundColor: NSColor(white: 0.45, alpha: 1),
        ]))
        line.append(NSAttributedString(string: kicker.uppercased(), attributes: [
            .font: font,
            .kern: 0.8,
            .foregroundColor: NSColor(srgbRed: 1, green: 0.62, blue: 0.12, alpha: 1),
        ]))
        return line
    }

    private static func styleMono(_ field: NSTextField, color: NSColor) {
        field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        field.textColor = color
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = 1
    }
}
