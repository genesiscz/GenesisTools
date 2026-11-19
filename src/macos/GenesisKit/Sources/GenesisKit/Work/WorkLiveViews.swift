import SwiftUI

private struct WorkRowUpdates: ViewModifier {
    @ObservedObject var screen: WorkScreenModel
    @GenReduceMotion private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(screen.rowAnimation.flatMap { GenMotion.animation(expanding: $0, reduceMotion: reduceMotion) },
                          value: screen.snapshot)
    }
}

public extension View {
    /// Only a small change to an existing project's rows animates. The header stays outside this transaction.
    func workRowUpdates(screen: WorkScreenModel) -> some View {
        modifier(WorkRowUpdates(screen: screen))
    }
}
