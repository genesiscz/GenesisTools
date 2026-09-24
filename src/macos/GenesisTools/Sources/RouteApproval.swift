import AppKit
import Foundation

/// The Allow / Deny card for a route that runs a command. Same look as RouteToast: dark card,
/// gold hairline, the Genesis Tools mark. Return allows, Esc denies.
enum RouteApproval {
    /// The "Running" toast is already up (statusBar level, same spot) and would hide this card,
    /// so it steps aside while the question is open and only comes back when the run is allowed.
    static func ask(argv: [String], open: String?) -> Bool {
        let toasts = NSApp.windows.compactMap { $0 as? RouteToastCard }.filter { $0.isVisible }
        for toast in toasts {
            toast.orderOut(nil)
        }

        let card = RouteApprovalCard(argv: argv, open: open)
        let allowed = card.runModal()
        if allowed {
            for toast in toasts {
                toast.orderFrontRegardless()
            }
        }

        return allowed
    }
}

private enum Palette {
    static let card = NSColor(srgbRed: 0.09, green: 0.09, blue: 0.09, alpha: 0.97)
    static let hairline = NSColor(srgbRed: 0.73, green: 0.58, blue: 0.32, alpha: 0.55)
    static let gold = NSColor(srgbRed: 1, green: 0.62, blue: 0.12, alpha: 1)
    static let brand = NSColor(srgbRed: 0.96, green: 0.78, blue: 0.45, alpha: 0.9)
    static let text = NSColor(white: 0.96, alpha: 1)
    static let dim = NSColor(white: 0.55, alpha: 1)
    static let flag = NSColor(srgbRed: 0.96, green: 0.78, blue: 0.45, alpha: 0.85)
    static let well = NSColor(white: 1, alpha: 0.05)
    static let wellBorder = NSColor(white: 1, alpha: 0.08)
}

final class RouteApprovalCard: NSPanel {
    private var allowed = false

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    init(argv: [String], open: String?) {
        let body = ApprovalBody(argv: argv, open: open)
        let size = body.fittingSize
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        contentView = body
        body.onAnswer = { [weak self] answer in
            self?.finish(answer)
        }
        placeInTheMiddle()
    }

    func runModal() -> Bool {
        let resting = frame.origin
        alphaValue = 0
        setFrameOrigin(NSPoint(x: resting.x, y: resting.y - 14))
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
        orderFrontRegardless()
        fadeIn(to: resting)
        NSApp.runModal(for: self)
        orderOut(nil)
        return allowed
    }

    /// Stepped by a timer in `.common` modes, not `animator()`: the card is modal, and an animation
    /// that does not tick in the modal run loop would leave an invisible card waiting for a click.
    /// The timer stops itself after `duration`.
    private func fadeIn(to resting: NSPoint) {
        let start = Date()
        let duration = 0.28
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }

            let progress = min(1, Date().timeIntervalSince(start) / duration)
            let eased = CGFloat(1 - pow(1 - progress, 3))
            alphaValue = eased
            setFrameOrigin(NSPoint(x: resting.x, y: resting.y - 14 * (1 - eased)))
            if progress >= 1 {
                timer.invalidate()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    override func cancelOperation(_ sender: Any?) {
        finish(false)
    }

    private func finish(_ answer: Bool) {
        allowed = answer
        NSApp.stopModal()
    }

    private func placeInTheMiddle() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let size = frame.size
        setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
    }
}

private final class ApprovalBody: NSView {
    var onAnswer: ((Bool) -> Void)?

    private let width: CGFloat = 520

    init(argv: [String], open: String?) {
        super.init(frame: NSRect(x: 0, y: 0, width: 520, height: 260))
        wantsLayer = true
        layer?.backgroundColor = Palette.card.cgColor
        layer?.cornerRadius = 22
        layer?.borderWidth = 1
        layer?.borderColor = Palette.hairline.cgColor

        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 40),
            icon.heightAnchor.constraint(equalToConstant: 40),
        ])

        let header = NSStackView(views: [brandRow(), NSView(), icon])
        header.orientation = .horizontal
        header.alignment = .top

        let kicker = label("APPROVAL NEEDED", size: 12, weight: .semibold, color: Palette.gold)
        let headline = label(Self.headline(argv), size: 24, weight: .semibold, color: Palette.text)

        var rows: [NSView] = [header, kicker, headline, commandWell(argv)]
        if let program = argv.first, program.contains("/") {
            rows.append(caption("PROGRAM", Self.shorten(program)))
        }

        if let open, !open.isEmpty {
            rows.append(caption("THEN OPENS", open))
        }

        rows.append(label("Runs once, without a shell. Nothing happens if you deny.", size: 11, weight: .regular, color: Palette.dim))
        rows.append(buttonRow())

        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.setCustomSpacing(4, after: kicker)
        stack.setCustomSpacing(14, after: headline)
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: width),
            header.widthAnchor.constraint(equalToConstant: width - 48),
        ])

        for row in rows where row !== header {
            row.widthAnchor.constraint(lessThanOrEqualToConstant: width - 48).isActive = true
        }
    }

    required init?(coder: NSCoder) {
        nil
    }

    // MARK: Pieces

    private func brandRow() -> NSView {
        let dot = NSView()
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.wantsLayer = true
        dot.layer?.backgroundColor = Palette.gold.cgColor
        dot.layer?.cornerRadius = 4
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
        ])

        let brand = label("GENESIS TOOLS", size: 11, weight: .semibold, color: Palette.brand)
        let row = NSStackView(views: [dot, brand])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func commandWell(_ argv: [String]) -> NSView {
        let field = NSTextField(labelWithAttributedString: Self.command(argv))
        field.isSelectable = true
        field.lineBreakMode = .byCharWrapping
        field.maximumNumberOfLines = 0
        field.cell?.wraps = true
        field.preferredMaxLayoutWidth = width - 48 - 28
        field.translatesAutoresizingMaskIntoConstraints = false

        let well = NSView()
        well.wantsLayer = true
        well.layer?.backgroundColor = Palette.well.cgColor
        well.layer?.cornerRadius = 12
        well.layer?.borderWidth = 1
        well.layer?.borderColor = Palette.wellBorder.cgColor
        well.translatesAutoresizingMaskIntoConstraints = false
        well.addSubview(field)

        NSLayoutConstraint.activate([
            well.widthAnchor.constraint(equalToConstant: width - 48),
            field.leadingAnchor.constraint(equalTo: well.leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: well.trailingAnchor, constant: -14),
            field.topAnchor.constraint(equalTo: well.topAnchor, constant: 12),
            field.bottomAnchor.constraint(equalTo: well.bottomAnchor, constant: -12),
        ])
        return well
    }

    private func caption(_ title: String, _ value: String) -> NSView {
        let name = label(title, size: 10, weight: .semibold, color: Palette.dim)
        name.translatesAutoresizingMaskIntoConstraints = false
        name.widthAnchor.constraint(equalToConstant: 78).isActive = true

        let text = NSTextField(labelWithString: value)
        text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        text.textColor = NSColor(white: 0.82, alpha: 1)
        text.lineBreakMode = .byTruncatingMiddle
        text.isSelectable = true
        text.toolTip = value
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [name, text])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8
        return row
    }

    private func buttonRow() -> NSView {
        let deny = ApprovalButton(title: "Deny", hint: "esc", primary: false)
        deny.keyEquivalent = "\u{1b}"
        deny.target = self
        deny.action = #selector(denyClicked)

        let allow = ApprovalButton(title: "Allow", hint: "↩", primary: true)
        allow.keyEquivalent = "\r"
        allow.target = self
        allow.action = #selector(allowClicked)

        let row = NSStackView(views: [NSView(), deny, allow])
        row.orientation = .horizontal
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        row.widthAnchor.constraint(equalToConstant: width - 48).isActive = true
        return row
    }

    @objc private func denyClicked() {
        onAnswer?(false)
    }

    @objc private func allowClicked() {
        onAnswer?(true)
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        field.cell?.wraps = true
        field.preferredMaxLayoutWidth = width - 48
        return field
    }

    // MARK: Text

    /// `Run tools say` for `[.../tools, say, ...]`; the program alone when the next word is a flag.
    /// A script behind a runner (`bun .../rohlik.ts add`) is named by the script, not the runner.
    private static func headline(_ argv: [String]) -> String {
        guard let program = argv.first else { return "Run a command" }
        var name = (program as NSString).lastPathComponent
        var rest = Array(argv.dropFirst())
        let runners: Set<String> = ["bun", "node", "deno", "python", "python3", "sh", "bash", "zsh"]
        if runners.contains(name), let script = rest.first, script.contains("/") {
            name = (script as NSString).lastPathComponent
            rest.removeFirst()
        }

        if let word = rest.first, !word.hasPrefix("-"), !word.contains("/"), word.count <= 24 {
            return "Run \(name) \(word)"
        }

        return "Run \(name)"
    }

    /// The argv as a shell would need it typed: quoted where a word has spaces, program in gold,
    /// flags tinted, values white. Only for reading; the argv itself never meets a shell.
    private static func command(_ argv: [String]) -> NSAttributedString {
        let regular = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let bold = NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        paragraph.lineBreakMode = .byCharWrapping

        let result = NSMutableAttributedString()
        for (index, arg) in argv.enumerated() {
            if index > 0 {
                result.append(NSAttributedString(string: " ", attributes: [.font: regular]))
            }

            let shown = index == 0 ? (arg as NSString).lastPathComponent : quoted(arg)
            let color = index == 0 ? Palette.gold : (arg.hasPrefix("-") ? Palette.flag : Palette.text)
            result.append(NSAttributedString(string: shown, attributes: [
                .font: index == 0 ? bold : regular,
                .foregroundColor: color,
            ]))
        }

        result.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: result.length))
        return result
    }

    private static func quoted(_ arg: String) -> String {
        if arg.isEmpty {
            return "''"
        }

        let plain = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_./:=@%+,~"))
        if arg.unicodeScalars.allSatisfy({ plain.contains($0) }) {
            return arg
        }

        return "'" + arg.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func shorten(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }

        return path
    }
}

private final class ApprovalButton: NSButton {
    init(title: String, hint: String, primary: Bool) {
        super.init(frame: .zero)
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.backgroundColor = primary ? Palette.gold.cgColor : NSColor(white: 1, alpha: 0.07).cgColor
        layer?.borderWidth = primary ? 0 : 1
        layer?.borderColor = NSColor(white: 1, alpha: 0.12).cgColor

        let ink = primary ? NSColor(white: 0.08, alpha: 1) : Palette.text
        let hintInk = primary ? NSColor(white: 0.08, alpha: 0.55) : Palette.dim
        let text = NSMutableAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: ink,
        ])
        text.append(NSAttributedString(string: "   \(hint)", attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: hintInk,
        ]))
        attributedTitle = text

        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(greaterThanOrEqualToConstant: 112),
            heightAnchor.constraint(equalToConstant: 34),
        ])
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
