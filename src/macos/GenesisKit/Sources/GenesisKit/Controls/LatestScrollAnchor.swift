import SwiftUI

/// Opens at recent content and follows growth only while the reader remains at the end.
public struct LatestScrollAnchor: ViewModifier {
    public let enabled: Bool
    public let identity: String
    @State private var atLatest = true

    public init(enabled: Bool = true, identity: String = "") {
        self.enabled = enabled
        self.identity = identity
    }

    public func body(content: Content) -> some View {
        if !enabled {
            content
        } else if #available(macOS 15, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(atLatest ? .bottom : nil, for: .sizeChanges)
                .defaultScrollAnchor(.top, for: .alignment)
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentSize.height - geometry.containerSize.height - geometry.contentOffset.y <= 80
                } action: { _, value in
                    atLatest = value
                }
                .id(identity)
                .onChange(of: identity) { _, _ in atLatest = true }
        } else {
            content.defaultScrollAnchor(.bottom).id(identity)
        }
    }
}
