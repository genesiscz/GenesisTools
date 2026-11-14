import Combine
import SwiftUI

/// The live dictation's voice level. Its own object so that only `WidgetVoiceBars` redraws at the audio frame rate:
/// on `WidgetModel` the level made every view that observes the model run its body for each frame.
@MainActor
public final class WidgetVoiceMeter: ObservableObject {
    @Published public var level = 0.0

    public init() {}
}

/// The reply box's level bars: the only reader of `WidgetVoiceMeter`.
struct WidgetVoiceBars: View {
    @ObservedObject var meter: WidgetVoiceMeter
    let reduceMotion: Bool

    var body: some View {
        let _ = RenderProbe.hit("widget.voice.bars")
        VoiceLevelBars(level: min(1, meter.level * 5), tint: .red, reduceMotion: reduceMotion)
    }
}
