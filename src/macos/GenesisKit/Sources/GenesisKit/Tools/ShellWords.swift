import Foundation

/// Text as POSIX shell words, for a command line a person copies or a terminal runs (a resume command, a cmux
/// launch, a generated script). One place, so every copy quotes the same way.
public enum ShellWords {
    private static let plain = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")

    /// Always one word: single quotes, and a `'` inside written as `'\''`. For a path or any text that is data.
    public static func quoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// A command word as typed: bare when no character in it means anything to a shell, else `quoted`. A leading `=`
    /// is quoted too: zsh (EQUALS) turns `=cat` into the path of `cat`.
    public static func word(_ text: String) -> String {
        let bare = !text.isEmpty && !text.hasPrefix("=") && text.unicodeScalars.allSatisfy { plain.contains($0) }
        return bare ? text : quoted(text)
    }
}
