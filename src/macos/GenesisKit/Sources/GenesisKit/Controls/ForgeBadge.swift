import AppKit
import SwiftUI

/// The forge a PR/MR or project lives on, with its mark and its words ("PR #436" vs "MR !7412").
public enum Forge: String, Sendable {
    case github
    case gitlab

    /// `github` / `gitlab` as `tools` names them (`origin.kind`); anything else is nil.
    public init?(kind: String?) {
        guard let kind, let forge = Forge(rawValue: kind.lowercased()) else { return nil }
        self = forge
    }

    public var name: String { self == .github ? "GitHub" : "GitLab" }
    /// `#436` on GitHub, `!7412` on GitLab.
    public func label(_ number: Int) -> String { self == .github ? "#\(number)" : "!\(number)" }
    public var noun: String { self == .github ? "PR" : "MR" }
    /// The mark's own colour: GitHub's is monochrome, GitLab's tanuki orange.
    public var tint: Color { self == .github ? Color.white.opacity(0.92) : Color(red: 0.99, green: 0.43, blue: 0.15) }
}

/// The forge's logo as a shape, from its 16 × 16 SVG path, scaled to the frame it is given.
public struct ForgeMark: Shape {
    public let forge: Forge

    public init(_ forge: Forge) {
        self.forge = forge
    }

    public func path(in rect: CGRect) -> Path {
        let unit = forge == .github ? Self.github : Self.gitlab
        let scale = min(rect.width, rect.height) / 16
        let dx = rect.minX + (rect.width - 16 * scale) / 2
        let dy = rect.minY + (rect.height - 16 * scale) / 2
        return unit.applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: dx, ty: dy))
    }

    /// The Octicons `mark-github` outline; its one arc is written as the cubic that draws it.
    static let github = SVGPath.parse(
        "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38C13.81 14.49 16 11.44 16 8c0-4.42-3.58-8-8-8z"
    )

    /// The GitLab tanuki's silhouette: two ears over a jaw.
    static let gitlab = SVGPath.parse(
        "M8 15.2L.35 9.6C.1 9.42 0 9.1.09 8.8L2.25 1.6c.1-.33.57-.34.68-.01L5.1 6.1h5.8l2.17-4.51c.11-.33.58-.32.68.01l2.16 7.2c.09.3-.01.62-.26.8z"
    )
}

/// A pill naming where a PR/MR lives: the forge mark, "GitHub #436". A click opens it in the browser,
/// the tooltip shows the URL, and the context menu copies the link.
public struct ForgeBadge: View {
    let forge: Forge
    let number: Int
    let url: URL?
    let open: (URL) -> Void

    /// `open`: how the app opens a web page (its browser router), so a click follows the same rules.
    public init(forge: Forge, number: Int, url: URL?, open: @escaping (URL) -> Void) {
        self.forge = forge
        self.number = number
        self.url = url
        self.open = open
    }

    public var body: some View {
        let text = "\(forge.name) \(forge.label(number))"
        let pill = HStack(spacing: 5) {
            ForgeMark(forge)
                .fill(forge.tint)
                .frame(width: 13, height: 13)
            Text(verbatim: text)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(Capsule().fill(forge.tint.opacity(forge == .github ? 0.14 : 0.2)))
        .overlay(Capsule().stroke(forge.tint.opacity(0.45), lineWidth: 0.75))
        .fixedSize()
        if let url {
            Button { open(url) } label: { pill }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open the \(forge.noun) in the browser\n\(url.absoluteString)")
                .contextMenu {
                    Button("Copy link") { Clipboard.copy(url.absoluteString, what: "\(forge.noun) link") }
                    Button("Open in the browser") { open(url) }
                }
                .accessibilityLabel(Text(verbatim: text))
                .accessibilityAddTraits(.isLink)
                .accessibilityValue(Text(url.absoluteString))
        } else {
            pill.accessibilityLabel(Text(verbatim: text))
        }
    }
}

/// The subset of SVG path data the forge marks use: M, L, H, V, C, S and Z, absolute and relative, with
/// implicit repeats and the compact number forms (`.4.07`, `-.17`). Anything else ends the path there.
enum SVGPath {
    static func parse(_ data: String) -> Path {
        var path = Path()
        var tokens = Tokens(data)
        var command: Character = "M"
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?

        while let next = tokens.peek() {
            if case .command(let letter) = next {
                tokens.advance()
                command = letter
                if letter == "Z" || letter == "z" {
                    path.closeSubpath()
                    current = start
                    lastControl = nil
                    continue
                }
            }
            let relative = command.isLowercase
            let base = relative ? current : .zero
            func point() -> CGPoint? {
                guard let x = tokens.number(), let y = tokens.number() else { return nil }
                return CGPoint(x: base.x + x, y: base.y + y)
            }
            switch command.uppercased() {
            case "M":
                guard let target = point() else { return path }
                path.move(to: target)
                current = target
                start = target
                lastControl = nil
                // Pairs after a moveto are linetos.
                command = relative ? "l" : "L"
            case "L":
                guard let target = point() else { return path }
                path.addLine(to: target)
                current = target
                lastControl = nil
            case "H":
                guard let x = tokens.number() else { return path }
                current = CGPoint(x: (relative ? current.x : 0) + x, y: current.y)
                path.addLine(to: current)
                lastControl = nil
            case "V":
                guard let y = tokens.number() else { return path }
                current = CGPoint(x: current.x, y: (relative ? current.y : 0) + y)
                path.addLine(to: current)
                lastControl = nil
            case "C":
                guard let first = point(), let second = point(), let target = point() else { return path }
                path.addCurve(to: target, control1: first, control2: second)
                current = target
                lastControl = second
            case "S":
                let first = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                guard let second = point(), let target = point() else { return path }
                path.addCurve(to: target, control1: first, control2: second)
                current = target
                lastControl = second
            default:
                return path
            }
        }
        return path
    }

    private enum Token: Equatable {
        case command(Character)
        case number(CGFloat)
    }

    private struct Tokens {
        private var items: [Token] = []
        private var index = 0

        init(_ text: String) {
            var number = ""
            func flush() {
                if let value = Double(number) { items.append(.number(CGFloat(value))) }
                number = ""
            }
            for char in text {
                if char.isLetter, char != "e" {
                    flush()
                    items.append(.command(char))
                } else if char == "-" {
                    // A minus starts a new number unless it is an exponent's sign.
                    if !number.hasSuffix("e") { flush() }
                    number.append(char)
                } else if char == "." {
                    // A second dot starts a new number: `.4.07` is 0.4 then 0.07.
                    if number.contains(".") { flush() }
                    number.append(char)
                } else if char.isNumber || char == "e" {
                    number.append(char)
                } else {
                    flush()
                }
            }
            flush()
        }

        func peek() -> Token? { index < items.count ? items[index] : nil }
        mutating func advance() { index += 1 }

        mutating func number() -> CGFloat? {
            guard case .number(let value) = peek() else { return nil }
            index += 1
            return value
        }
    }
}
