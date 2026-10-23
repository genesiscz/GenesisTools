import SwiftUI

/// A command line in an approval window, set like a shell code block: monospaced, wrapped, selectable, with the program
/// and its subcommands in the text color, flags in blue, their values in orange and other arguments dimmed (Martin,
/// 2026-10-23: "make the "tools ...." show in some nice "format" as you would with the markdown view").
public struct ApprovalCommandText: View {
    public let command: String

    public init(command: String) {
        self.command = command
    }

    public var body: some View {
        Text(Self.styled(command))
            .font(.system(size: 11.5, design: .monospaced))
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, 9).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.primary.opacity(0.09)))
            .accessibilityLabel("Command: \(command)")
    }

    public enum Role: Equatable {
        case program, flag, value, argument
    }

    /// The words of a command line with their roles. A quoted word keeps its quotes and stays one word.
    public static func words(_ command: String) -> [(text: String, role: Role)] {
        var words: [String] = []
        var current = ""
        var quoted = false
        for character in command {
            if character == "\"" { quoted.toggle() }
            if character == " ", !quoted {
                if !current.isEmpty { words.append(current) }
                current = ""
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty { words.append(current) }

        var result: [(String, Role)] = []
        var inProgram = true
        var afterFlag = false
        for word in words {
            let role: Role
            if word.hasPrefix("-") {
                role = .flag
                inProgram = false
            } else if afterFlag {
                role = .value
            } else if inProgram, word.range(of: "^[a-z][a-z0-9-]*$", options: .regularExpression) != nil {
                role = .program
            } else {
                role = .argument
                inProgram = false
            }
            afterFlag = role == .flag && !word.contains("=")
            result.append((word, role))
        }
        return result
    }

    static func styled(_ command: String) -> AttributedString {
        var text = AttributedString()
        for (index, word) in words(command).enumerated() {
            if index > 0 { text += AttributedString(" ") }
            var part = AttributedString(word.text)
            switch word.role {
            case .program:
                part.foregroundColor = .primary
                part.font = .system(size: 11.5, weight: .semibold, design: .monospaced)
            case .flag: part.foregroundColor = Color(nsColor: .systemBlue)
            case .value: part.foregroundColor = Color(nsColor: .systemOrange)
            case .argument: part.foregroundColor = .secondary
            }
            text += part
        }
        return text
    }
}
