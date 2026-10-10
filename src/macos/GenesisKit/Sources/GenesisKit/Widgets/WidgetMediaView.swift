import AVKit
import AppKit
import CoreImage
import ImageIO
import SwiftUI

public struct WidgetThumbnail: View {
    let path: String
    @State private var image: NSImage?
    public init(path: String) { self.path = path }
    public var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .background(.black.opacity(0.15), in: RoundedRectangle(cornerRadius: 5))
        .task(id: path) { image = await TranscriptThumbnailCache.shared.thumbnail(for: path) }
    }
}

public enum WidgetMediaSelection: Identifiable {
    case video(String)
    case asset(String)
    case images([WidgetImageReference], String)
    public var id: String {
        switch self {
        case .video(let id), .asset(let id): return id
        case .images(_, let id): return id
        }
    }
}

@MainActor
final class WidgetVideoSettingsCommitter {
    private var current: WidgetVideoSettings
    /// The last value sent and not refused. `nil` after a refusal, so the next flush (Done, close) sends again.
    private var submitted: WidgetVideoSettings?
    private var pending: Task<Void, Never>?
    /// The second argument reports that the backend refused the value.
    private let commit: (WidgetVideoSettings, @escaping () -> Void) -> Void

    init(initial: WidgetVideoSettings, commit: @escaping (WidgetVideoSettings, @escaping () -> Void) -> Void) {
        current = initial
        submitted = initial
        self.commit = commit
    }
    func update(_ settings: WidgetVideoSettings) {
        current = settings
        pending?.cancel()
        pending = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            self?.flush()
        }
    }
    func flush(force: Bool = false) {
        pending?.cancel()
        pending = nil
        guard force || current != submitted else { return }
        let value = current
        submitted = value
        commit(value) { [weak self] in
            // A refusal of an older value must not undo a newer one that is still in flight.
            if self?.submitted == value { self?.submitted = nil }
        }
    }
    func finish(latest: WidgetVideoSettings? = nil) {
        if let latest { current = latest }
        flush()
    }
}

struct WidgetMediaView: View {
    @ObservedObject var model: WidgetModel
    let selection: WidgetMediaSelection
    let close: () -> Void
    @State private var settings = WidgetVideoSettings(
        fps: 2, framesPerImage: 16, minimumDifferencePct: 0)
    @State private var loadedSettings = false
    @State private var updates: WidgetVideoSettingsCommitter?
    @State private var player: AVPlayer?
    @State private var showSkipped = true

    private var asset: WidgetAsset? { model.snapshot?.state.assets[selection.id] }
    private var manifest: WidgetVideoManifest? { model.snapshot?.manifests[selection.id] }
    private var frozen: Bool {
        model.snapshot?.state.outgoing.contains {
            $0.assetIds.contains(selection.id) && $0.freezesAssets
        } == true
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(asset?.name ?? "Screenshots").font(.headline).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Done") { updates?.finish(latest: settings); close() }.keyboardShortcut(.cancelAction)
            }
            switch selection {
            case .video:
                video
            case .asset:
                if let asset {
                    WidgetImageCompare(
                        images: [
                            .init(
                                id: asset.id, path: asset.path, name: asset.name, width: asset.width,
                                height: asset.height)
                        ], selectedID: asset.id)
                }
            case .images(let images, let selectedID):
                WidgetImageCompare(images: images, selectedID: selectedID)
            }
        }
        .padding(22)
        .titlebarBackground(NativeSettingsBackdrop())
        .titlebarZone()
        .environment(\.nativeSettingsTheme,
            model.snapshot?.state.preferences.glassEffect == false ? .solid : model.appearance.theme)
        .nativeSettingsAppearance(model.appearance)
        .preferredColorScheme(.dark)
        .onAppear {
            if let asset, asset.type == "video" {
                settings = asset.settings ?? settings
                player = AVPlayer(url: URL(fileURLWithPath: asset.path))
                updatePlaybackRange(previous: nil)
            }
            updates = WidgetVideoSettingsCommitter(initial: settings) { value, refused in
                do {
                    model.action(["action": "video-settings", "id": .string(selection.id), "settings": try .value(value)],
                        failed: refused)
                } catch {
                    model.error = error.localizedDescription
                    refused()
                }
            }
            loadedSettings = true
        }
        .onDisappear {
            player?.pause()
            updates?.finish(latest: settings)
        }
        .onChange(of: settings) { previous, value in
            guard loadedSettings, !frozen else { return }
            updates?.update(value)
            if previous.startUs != value.startUs || previous.endUs != value.endUs {
                updatePlaybackRange(previous: previous)
            }
        }
    }

    private var video: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 18) {
                WidgetVideoPlayer(player: player).frame(width: 240, height: 145).clipShape(
                    RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Selected moment").font(.caption.weight(.semibold))
                        Spacer()
                        Button("Whole video") { settings.startUs = nil; settings.endUs = nil }.font(.caption)
                            .disabled(settings.startUs == nil && settings.endUs == nil)
                    }
                    rangeControl("Start", value: Binding(
                        get: { sampleRange.lowerBound / 1_000_000 },
                        set: { settings.setSampleStart(seconds: $0, durationUs: durationUs) }))
                    rangeControl("End", value: Binding(
                        get: { sampleRange.upperBound / 1_000_000 },
                        set: { settings.setSampleEnd(seconds: $0, durationUs: durationUs) }))
                    Divider()
                    Picker("Sample rate", selection: $settings.fps) {
                        ForEach([1, 2, 3, 4], id: \.self) { Text("\($0) FPS").tag($0) }
                    }.pickerStyle(.segmented)
                    Picker("Frames per image", selection: $settings.framesPerImage) {
                        ForEach([1, 4, 8, 16, 32], id: \.self) { Text("\($0)").tag($0) }
                    }.pickerStyle(.segmented)
                    HStack {
                        Text("Skip differences below \(settings.minimumDifferencePct, specifier: "%.1f")%")
                            .font(.caption)
                        Spacer()
                        TextField(
                            "Percent", value: $settings.minimumDifferencePct,
                            format: .number.precision(.fractionLength(1))
                        )
                        .frame(width: 48).textFieldStyle(.roundedBorder).accessibilityLabel("Difference threshold")
                        Button("Keep all") { settings.minimumDifferencePct = 0 }.font(.caption)
                    }
                    Slider(value: $settings.minimumDifferencePct, in: 0...100, step: 0.5)
                        .accessibilityLabel("Minimum frame difference percentage")
                }.padding(12).nativeGlassSurface(radius: 16).disabled(frozen)
            }
            Text(estimate).font(.caption).foregroundStyle(.secondary)
            if let error = asset?.error {
                Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                Button("Prepare again") { updates?.flush(force: true) }.disabled(frozen)
            }
            if asset?.status != "ready" || manifest?.settings != settings {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Preparing the latest settings… You can keep changing them.").font(.caption)
                }
            }
            if let manifest {
                HStack {
                    Text(
                        "\(manifest.counts.kept) kept · \(manifest.counts.skipped) skipped · \(manifest.counts.images) images"
                    )
                    .font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Toggle("Show skipped", isOn: $showSkipped).toggleStyle(.checkbox).font(.caption)
                }
                GeometryReader { proxy in
                    HStack(spacing: 1) {
                        ForEach(manifest.frames) { frame in
                            Rectangle().fill(frame.kept ? Color.blue : Color.orange.opacity(0.65))
                        }
                    }.frame(width: proxy.size.width, height: 9).clipShape(Capsule())
                }.frame(height: 9).accessibilityLabel(
                    "\(manifest.counts.kept) retained and \(manifest.counts.skipped) skipped frames")
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 110))], spacing: 10) {
                        ForEach(manifest.frames.filter { showSkipped || $0.kept }) { frame in
                            VStack(alignment: .leading, spacing: 3) {
                                WidgetThumbnail(path: frame.path).frame(height: 70).opacity(frame.kept ? 1 : 0.45)
                                HStack {
                                    Text(String(format: "%.2fs", frame.actualUs / 1_000_000))
                                    Spacer()
                                    if let difference = frame.differencePct {
                                        Text(String(format: "%.1f%%", difference))
                                    }
                                }.font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                                Text(frame.kept ? "Kept" : "Skipped").font(.caption2).foregroundStyle(
                                    frame.kept ? .blue : .orange)
                            }
                            .contextMenu {
                                Button("Open full frame") {
                                    NSWorkspace.shared.open(URL(fileURLWithPath: frame.path))
                                }
                            }
                        }
                    }
                }
                if !frozen && settings.minimumDifferencePct > 0 {
                    HStack {
                        Image(
                            systemName: asset?.confirmedRevision == asset?.revision
                                ? "checkmark.circle.fill" : "exclamationmark.triangle"
                        )
                        .foregroundStyle(asset?.confirmedRevision == asset?.revision ? .green : .orange)
                        Text("Review skipped frames: small visual changes can still matter.").font(.caption)
                        Spacer()
                        Button(
                            asset?.confirmedRevision == asset?.revision
                                ? "Confirmed" : "Use these \(manifest.counts.kept) frames"
                        ) {
                            guard let asset, let revision = asset.revision else { return }
                            model.action([
                                "action": "confirm-video", "id": .string(asset.id),
                                "revision": .number(Double(revision)),
                            ])
                        }.buttonStyle(.borderedProminent)
                            .disabled(
                                manifest.settings != settings || asset?.status != "ready"
                                    || asset?.confirmedRevision == asset?.revision)
                    }
                }
                Text(
                    "The original video stays attached. The agent receives its path, timestamps, contact sheets, and instructions for inspecting other frames."
                )
                .font(.caption2).foregroundStyle(.secondary)
            } else {
                Spacer()
            }
        }
    }
    private var durationUs: Double { asset?.durationUs ?? 1 }
    private var sampleRange: ClosedRange<Double> { settings.sampleRange(durationUs: durationUs) }

    private func rangeControl(_ title: String, value: Binding<Double>) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.caption).frame(width: 32, alignment: .leading)
            Slider(value: value, in: 0...max(0.000001, durationUs / 1_000_000))
                .accessibilityLabel("Video \(title.lowercased()) time")
            TextField(title, value: value, format: .number.precision(.fractionLength(2)))
                .textFieldStyle(.roundedBorder).frame(width: 64)
                .accessibilityLabel("Video \(title.lowercased()) seconds")
            Text("s").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func updatePlaybackRange(previous: WidgetVideoSettings?) {
        guard let player else { return }
        let range = sampleRange
        player.pause()
        player.currentItem?.reversePlaybackEndTime = CMTime(seconds: range.lowerBound / 1_000_000, preferredTimescale: 1_000_000)
        player.currentItem?.forwardPlaybackEndTime = CMTime(seconds: range.upperBound / 1_000_000, preferredTimescale: 1_000_000)
        let target = previous == nil || previous?.startUs != settings.startUs
            ? range.lowerBound : max(range.lowerBound, range.upperBound - 1_000)
        player.seek(to: CMTime(seconds: target / 1_000_000, preferredTimescale: 1_000_000), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private var estimate: String {
        let seconds = (sampleRange.upperBound - sampleRange.lowerBound) / 1_000_000
        let count = Int(ceil(seconds * Double(settings.fps)))
        let images = Int(ceil(Double(count) / Double(settings.framesPerImage)))
        return String(format: "%.2f–%.2fs · %.2f seconds selected", sampleRange.lowerBound / 1_000_000, sampleRange.upperBound / 1_000_000, seconds)
            + " · Before filtering: \(count) frames → \(images) images, up to \(settings.framesPerImage) frames each."
    }
}

private struct WidgetVideoPlayer: NSViewRepresentable {
    let player: AVPlayer?
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.videoGravity = .resizeAspect
        view.player = player
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }
    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
        view.player?.pause()
        view.player = nil
    }
}

private struct WidgetImageCompare: View {
    let images: [WidgetImageReference]
    @State var selectedID: String
    @State private var secondID = ""
    @State private var mode = "Single"
    @State private var loaded: [String: NSImage] = [:]
    @State private var difference: NSImage?
    @State private var wipe = 0.5
    @State private var zoom = 1.0
    @State private var failure: String?
    private var first: WidgetImageReference? { images.first { $0.id == selectedID } }
    private var second: WidgetImageReference? { images.first { $0.id == secondID } }

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Picker("Image", selection: $selectedID) {
                    ForEach(images) { Text($0.label ?? $0.name).tag($0.id) }
                }
                if images.count > 1 {
                    Picker("Compare", selection: $secondID) {
                        ForEach(images) { Text($0.label ?? $0.name).tag($0.id) }
                    }
                }
            }
            if images.count > 1 {
                Picker("Comparison", selection: $mode) {
                    ForEach(["Single", "Side by side", "Wipe", "Difference"], id: \.self) { Text($0).tag($0) }
                }.pickerStyle(.segmented)
            }
            GeometryReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    Group {
                        if mode == "Side by side" {
                            HStack(spacing: 10) {
                                bitmap(loaded[selectedID])
                                bitmap(loaded[secondID])
                            }
                        } else if mode == "Wipe" {
                            ZStack {
                                bitmap(loaded[secondID])
                                bitmap(loaded[selectedID]).mask(alignment: .leading) {
                                    Rectangle().frame(width: proxy.size.width * zoom * wipe)
                                }
                            }
                        } else if mode == "Difference" {
                            bitmap(difference)
                        } else {
                            bitmap(loaded[selectedID])
                        }
                    }.frame(width: proxy.size.width * zoom, height: proxy.size.height * zoom)
                }
            }.background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
            if mode == "Wipe" { Slider(value: $wipe, in: 0...1).accessibilityLabel("Comparison wipe") }
            HStack {
                Image(systemName: "minus.magnifyingglass")
                Slider(value: $zoom, in: 1...4).frame(width: 150).accessibilityLabel("Image zoom")
                Image(systemName: "plus.magnifyingglass")
                Spacer()
                if let first {
                    Text("\(first.width) × \(first.height)").font(.caption).foregroundStyle(.secondary)
                    Button("Open original") { NSWorkspace.shared.open(URL(fileURLWithPath: first.path)) }
                }
            }
            if let failure { Text(failure).font(.caption).foregroundStyle(.orange) }
            if mode == "Difference" {
                Text(
                    "Absolute pixel difference at preview resolution. Black means equal; images with different dimensions are not compared."
                )
                .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .task {
            if let group = first?.comparison?.group,
                let counterpart = images.first(where: {
                    $0.id != selectedID && $0.comparison?.group == group
                })
            {
                secondID = counterpart.id
            } else {
                secondID = images.first(where: { $0.id != selectedID })?.id ?? selectedID
            }
            for image in images {
                let cg = await Task.detached(priority: .userInitiated) { () -> CGImage? in
                    guard
                        let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: image.path) as CFURL, nil)
                    else { return nil }
                    return CGImageSourceCreateThumbnailAtIndex(
                        source, 0,
                        [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceThumbnailMaxPixelSize: 2048,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                        ] as CFDictionary)
                }.value
                if let cg {
                    loaded[image.id] = NSImage(cgImage: cg, size: .zero)
                } else {
                    failure = "An image is no longer readable: " + image.name
                }
            }
            updateDifference()
        }
        .onChange(of: selectedID) { _, _ in updateDifference() }
        .onChange(of: secondID) { _, _ in updateDifference() }
    }

    @ViewBuilder private func bitmap(_ image: NSImage?) -> some View {
        if let image {
            Image(nsImage: image).resizable().scaledToFit()
        } else {
            Image(systemName: "photo").foregroundStyle(.secondary)
        }
    }
    private func updateDifference() {
        difference = nil
        guard let first, let second, first.width == second.width, first.height == second.height,
            let a = loaded[first.id]?.cgImage(forProposedRect: nil, context: nil, hints: nil),
            let b = loaded[second.id]?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return }
        let output = CIImage(cgImage: a).applyingFilter(
            "CIDifferenceBlendMode", parameters: [kCIInputBackgroundImageKey: CIImage(cgImage: b)])
        if let result = CIContext().createCGImage(output, from: output.extent) {
            difference = NSImage(cgImage: result, size: .zero)
        }
    }
}
