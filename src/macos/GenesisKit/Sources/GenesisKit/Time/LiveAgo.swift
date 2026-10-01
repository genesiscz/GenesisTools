import SwiftUI

/// A relative time that stays current on screen: a `LiveTime` in the system's short words ("20 sec.
/// ago", "5 min. ago") by default. The label keeps its own clock, so nothing above it re-renders per
/// tick. `format` builds the whole text around the time ("read \($0)"); without a date it shows
/// `fallback`.
public struct LiveAgo: View {
    let date: Date?
    var fallback: String
    var style: LiveTimeStyle
    var format: (String) -> String

    public init(date: Date?, fallback: String = "", style: LiveTimeStyle = .short, format: @escaping (String) -> String = { $0 }) {
        self.date = date
        self.fallback = fallback
        self.style = style
        self.format = format
    }

    public var body: some View {
        if let date {
            LiveTime(date: date, style: style, format: format)
        } else {
            Text(verbatim: format(fallback))
        }
    }
}
