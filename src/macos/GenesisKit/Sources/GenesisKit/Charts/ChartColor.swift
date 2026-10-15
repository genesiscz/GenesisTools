import Foundation

/// An sRGB colour a host gives a chart node (to colour by age or type instead of by branch) or a screen effect's glow.
/// Plain numbers, so a value stays `Sendable` and `Equatable`. In the core, so GenesisKitCharts and GenesisKitOverlay
/// share it without depending on each other.
public struct ChartColor: Equatable, Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}
