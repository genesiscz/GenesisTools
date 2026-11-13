import SwiftUI

/// Whether a file the reader picked (the music, a voiceover) is gone, checked on a background queue when the view
/// appears and whenever its path changes. A view body never touches the disk: such a file can sit on an external or
/// network volume, and every step of a volume slider evaluates these rows again. Until the first check answers, the
/// file counts as there, as most are.
struct FileMissing: ViewModifier {
    let path: String
    @Binding var missing: Bool

    func body(content: Content) -> some View {
        content.task(id: path) {
            let gone = await Self.check(path)
            if !Task.isCancelled { missing = gone }
        }
    }

    nonisolated static func check(_ path: String) async -> Bool {
        await Task.detached(priority: .utility) { !FileManager.default.fileExists(atPath: path) }.value
    }
}

extension View {
    func fileMissing(_ path: String, into missing: Binding<Bool>) -> some View {
        modifier(FileMissing(path: path, missing: missing))
    }
}
