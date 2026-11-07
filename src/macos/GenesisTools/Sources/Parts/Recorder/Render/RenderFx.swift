import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

// Round 4 fx-render: transitions at the joins of two clips, the magnifier lens and the 3D tilt camera. The edit's
// shape is in EditProject (`transitions`, `lens`, `tilt`) and src/utils/recording-editor/fx.ts; EditRenderer calls
// these per frame, so the preview and every export draw the same.

/// A transition blends each side of a join with a still of the other side, so no duration changes: before the join
/// the outgoing clip plays on while the incoming clip's first frame comes in, after it the incoming clip plays while
/// the outgoing clip's last frame goes.
enum TransitionLook {
    struct Join: Equatable {
        var clip: String
        /// Output microseconds of the join.
        var atUs: Int64
        var transition: EditProject.Transition
        /// The outgoing clip's last moment and the incoming clip's first, in source microseconds.
        var outgoingSourceUs: Int64
        var incomingSourceUs: Int64
        /// Half the transition, held inside half of each neighbouring clip.
        var halfUs: Int64
    }

    /// What one frame inside a transition draws.
    struct Mark {
        var kind: EditProject.TransitionKind
        /// 0 at the transition's start, 1 at its end; 0.5 is the join.
        var progress: Double
        /// True after the join: the live frame is the incoming clip's and the still is the outgoing clip's last.
        var incoming: Bool
        var otherSourceUs: Int64
        /// The redactions showing at the still's own source time.
        var otherRedactions: [EditProject.Redaction]
    }

    /// Every join with a transition: the start of a clip whose source does not continue the clip before it (a split
    /// alone joins nothing), as `transitionJoins` in fx.ts.
    static func joins(in project: EditProject) -> [Join] {
        guard let settings = project.transitions else { return [] }
        var joins: [Join] = []
        var at: Int64 = 0
        var previous: EditProject.Clip?
        for clip in project.clips where clip.sourceDurationUs > 0 {
            if let previous, previous.toUs != clip.fromUs {
                let transition = settings.joins?[clip.id] ?? settings.default
                let half = min(Int64(transition.ms) * 500, previous.outputDurationUs / 2, clip.outputDurationUs / 2)
                if transition.kind != .none, half > 0 {
                    joins.append(Join(clip: clip.id, atUs: at, transition: transition, outgoingSourceUs: max(previous.fromUs, previous.toUs - 1),
                                      incomingSourceUs: clip.fromUs, halfUs: half))
                }
            }
            at += clip.outputDurationUs
            previous = clip
        }
        return joins
    }

    static func mark(atOutputUs us: Int64, project: EditProject, track: CursorTrack?) -> Mark? {
        guard let join = joins(in: project).first(where: { us >= $0.atUs - $0.halfUs && us < $0.atUs + $0.halfUs }) else { return nil }
        let progress = Double(us - (join.atUs - join.halfUs)) / Double(2 * join.halfUs)
        let incoming = us >= join.atUs
        let other = incoming ? join.outgoingSourceUs : join.incomingSourceUs
        let redactions = (project.redactions ?? []).filter { other >= $0.startUs && other < $0.endUs }
            .map { ZoomState.placed($0, atSourceUs: other, track: track) }
        return Mark(kind: join.transition.kind, progress: min(1, max(0, progress)), incoming: incoming, otherSourceUs: other,
                    otherRedactions: redactions)
    }

    static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }

    /// The live frame and the still of the other side, blended by `mark`; both are the source picture.
    static func blend(live: CIImage, still: CIImage, mark: Mark) -> CIImage {
        let extent = live.extent
        let outgoing = mark.incoming ? still : live
        let incoming = mark.incoming ? live : still
        let p = smooth(mark.progress)
        switch mark.kind {
        case .none:
            return live
        case .crossfade:
            return dissolve(outgoing, incoming, p, extent: extent)
        case .zoom:
            // The outgoing side rushes toward the viewer, the incoming side settles from 1.4×, crossing at the join.
            let a = scaled(outgoing, by: 1 + 0.6 * p, extent: extent)
            let b = scaled(incoming, by: 1 + 0.4 * (1 - p), extent: extent)
            return dissolve(a, b, p, extent: extent)
        case .blur:
            // A soft edge wipes from left to right while both sides blur, most at the join.
            let edge = extent.minX + (p * 1.4 - 0.2) * extent.width
            let soft = extent.width * 0.2
            let gradient = CIFilter.linearGradient()
            gradient.point0 = CGPoint(x: edge - soft / 2, y: 0)
            gradient.point1 = CGPoint(x: edge + soft / 2, y: 0)
            gradient.color0 = .white
            gradient.color1 = .clear
            let mask = (gradient.outputImage ?? CIImage(color: .white)).cropped(to: extent)
            let wiped = incoming.applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: outgoing, kCIInputMaskImageKey: mask])
                .cropped(to: extent)
            let sigma = sin(.pi * mark.progress) * extent.height * 0.018
            guard sigma > 0.5 else { return wiped }
            return wiped.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: extent)
        }
    }

    private static func dissolve(_ from: CIImage, _ to: CIImage, _ time: Double, extent: CGRect) -> CIImage {
        from.applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: to, kCIInputTimeKey: time]).cropped(to: extent)
    }

    private static func scaled(_ image: CIImage, by factor: Double, extent: CGRect) -> CIImage {
        guard factor > 1.0001 else { return image }
        let transform = CGAffineTransform(translationX: -extent.midX, y: -extent.midY)
            .concatenating(CGAffineTransform(scaleX: factor, y: factor))
            .concatenating(CGAffineTransform(translationX: extent.midX, y: extent.midY))
        return image.clampedToExtent().transformed(by: transform).cropped(to: extent)
    }
}

/// The source pictures transitions blend with: one frame per source time, read once from the movie and kept.
final class TransitionStills: @unchecked Sendable {
    private let generator: AVAssetImageGenerator
    private let lock = NSLock()
    private var images: [Int64: CIImage?] = [:]

    init(asset: AVAsset) {
        generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = false
        // The frame on screen at the time: never a later one, so the outgoing clip's last frame is its own.
        generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 4)
        generator.requestedTimeToleranceAfter = .zero
    }

    /// The frame at `us`, placed on `extent` (the size the video composition hands the filter); nil when the movie
    /// has none there, and the transition then draws as a hard cut. Waits at most 3 s for a first read.
    func image(atSourceUs us: Int64, extent: CGRect) -> CIImage? {
        lock.lock()
        if let cached = images[us] {
            lock.unlock()
            return cached.map { fit($0, to: extent) }
        }
        lock.unlock()
        final class Box: @unchecked Sendable { var image: CGImage? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        generator.generateCGImageAsynchronously(for: EditRenderer.us(us)) { image, _, error in
            box.image = image
            if let error { HubPerf.log("recorder.transition: no frame at \(us) µs: \(error.localizedDescription)") }
            done.signal()
        }
        if done.wait(timeout: .now() + 3) == .timedOut {
            HubPerf.log("recorder.transition: the frame at \(us) µs took over 3 s; this frame draws a hard cut")
            return nil
        }
        let image = box.image.map { CIImage(cgImage: $0) }
        lock.lock()
        images[us] = image
        lock.unlock()
        return image.map { fit($0, to: extent) }
    }

    private func fit(_ image: CIImage, to extent: CGRect) -> CIImage {
        let source = image.extent
        guard source.width > 0, source.height > 0 else { return image }
        return image
            .transformed(by: CGAffineTransform(translationX: -source.minX, y: -source.minY))
            .transformed(by: CGAffineTransform(scaleX: extent.width / source.width, y: extent.height / source.height))
            .transformed(by: CGAffineTransform(translationX: extent.minX, y: extent.minY))
    }
}

/// The magnifier lens: a round, magnified copy of the picture under a point, with a ring and a soft shadow, drawn
/// on the zoomed picture so it keeps its size through a zoom.
enum LensLook {
    struct Mark: Equatable {
        /// The lens centre, 0...1 of the source picture from the top left.
        var x: Double
        var y: Double
        var radius: Double
        var magnification: Double
        var ring: String
        var opacity: Double
    }

    /// The lenses at a source time, each fading in and out over 0.2 s; a following lens sits on the cursor averaged
    /// over ±100 ms (a movie without a cursor track holds the lens's own point).
    static func marks(atSourceUs us: Int64, project: EditProject, track: CursorTrack?) -> [Mark] {
        (project.lens?.items ?? []).compactMap { lens in
            guard us >= lens.startUs, us < lens.endUs else { return nil }
            let fade = Double(min(200_000, max(1, (lens.endUs - lens.startUs) / 3)))
            let opacity = max(0, min(1, Double(us - lens.startUs) / fade, Double(lens.endUs - us) / fade))
            let point = lens.follow ? track?.averagedPoint(atMs: Double(us) / 1000, halfMs: 100) : nil
            return Mark(x: point?.x ?? lens.x, y: point?.y ?? lens.y, radius: lens.radius, magnification: lens.magnification,
                        ring: lens.ring, opacity: opacity)
        }
    }

    /// Where a source point lands on the picture (Core Image coordinates, y up) under the zoom `view`.
    static func pictureCenter(x: Double, y: Double, view: ZoomCurve.View, picture: CGRect) -> CGPoint {
        let rect = view.scale > 1.0005 ? view.rect : CGRect(x: 0, y: 0, width: 1, height: 1)
        let u = (x - rect.minX) / rect.width
        let v = (y - rect.minY) / rect.height
        return CGPoint(x: picture.minX + u * picture.width, y: picture.minY + (1 - v) * picture.height)
    }

    static func draw(_ marks: [Mark], view: ZoomCurve.View, on picture: CIImage) -> CIImage {
        let extent = picture.extent
        var result = picture
        for mark in marks where mark.opacity > 0.001 {
            let center = pictureCenter(x: mark.x, y: mark.y, view: view, picture: extent)
            // It grows from 85 % as it fades in.
            let radius = mark.radius * min(extent.width, extent.height) * (0.85 + 0.15 * mark.opacity)
            guard radius > 2 else { continue }
            let ring = max(2, radius * 0.045)
            let magnify = CGAffineTransform(translationX: -center.x, y: -center.y)
                .concatenating(CGAffineTransform(scaleX: mark.magnification, y: mark.magnification))
                .concatenating(CGAffineTransform(translationX: center.x, y: center.y))
            let inside = disc(center: center, radius: radius, color: .white)
            let content = picture.clampedToExtent().transformed(by: magnify)
                .applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: inside])
            let border = disc(center: center, radius: radius + ring, color: Looks.color(mark.ring))
            let shadow = disc(center: CGPoint(x: center.x, y: center.y - radius * 0.06), radius: radius * 1.12,
                              color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.5), soft: radius * 0.22)
            var lens = content.composited(over: border).composited(over: shadow)
            if mark.opacity < 0.999 {
                lens = lens.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: mark.opacity)])
            }
            result = lens.composited(over: result).cropped(to: extent)
        }
        return result
    }

    /// A filled circle with a 1.5 px (or `soft`) edge.
    static func disc(center: CGPoint, radius: Double, color: CIColor, soft: Double = 1.5) -> CIImage {
        let gradient = CIFilter.radialGradient()
        gradient.center = center
        gradient.radius0 = Float(max(0, radius - soft))
        gradient.radius1 = Float(radius)
        gradient.color0 = color
        gradient.color1 = CIColor(red: color.red, green: color.green, blue: color.blue, alpha: 0)
        let box = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        return (gradient.outputImage ?? CIImage.empty()).cropped(to: box)
    }
}

/// The 3D tilt camera: the framed picture (with its shadow) turned slightly about two axes and seen in perspective,
/// drifting slowly, with a stronger tilt that settles at the start and comes back at the end.
enum TiltLook {
    struct Pose: Equatable {
        /// Radians about the horizontal axis (top away from the viewer when positive) and the vertical axis.
        var pitch: Double
        var yaw: Double
        /// The picture's scale, so its tilted corners stay on the canvas.
        var scale: Double
    }

    private static func degrees(_ value: Double) -> Double { value * .pi / 180 }

    static func pose(atOutputUs us: Int64, lengthUs: Int64, tilt: EditProject.Tilt) -> Pose? {
        let strength = min(1, max(0, tilt.strength))
        let seconds = Double(us) / 1_000_000
        var pitch: Double
        var yaw: Double
        if tilt.drift {
            pitch = strength * degrees(4 + 1.5 * sin(2 * .pi * seconds / 9 + 1))
            yaw = strength * degrees(6 * sin(2 * .pi * seconds / 13))
        } else {
            pitch = strength * degrees(4)
            yaw = strength * degrees(-5)
        }
        var scale = 1 - 0.07 * strength
        let sweep = max(0.4, strength)
        if tilt.tiltIn, tilt.inMs > 0 {
            let left = 1 - TransitionLook.smooth(min(1, Double(us) / (Double(tilt.inMs) * 1000)))
            pitch += left * degrees(22) * sweep
            yaw -= left * degrees(28) * sweep
            scale *= 1 - 0.14 * left
        }
        if tilt.tiltOut, tilt.outMs > 0 {
            let left = 1 - TransitionLook.smooth(min(1, Double(max(0, lengthUs - us)) / (Double(tilt.outMs) * 1000)))
            pitch += left * degrees(22) * sweep
            yaw += left * degrees(28) * sweep
            scale *= 1 - 0.14 * left
        }
        guard abs(pitch) > 1e-5 || abs(yaw) > 1e-5 || abs(scale - 1) > 1e-5 else { return nil }
        return Pose(pitch: pitch, yaw: yaw, scale: scale)
    }

    /// Where a point of the canvas (Core Image coordinates) lands after the turn about `pivot`, seen from a camera
    /// 2.2 canvas widths away.
    static func project(_ point: CGPoint, pose: Pose, pivot: CGPoint, distance: Double) -> CGPoint {
        let x = Double(point.x - pivot.x), y = Double(point.y - pivot.y)
        let x1 = x * cos(pose.yaw)
        let z1 = x * sin(pose.yaw)
        let y2 = y * cos(pose.pitch) - z1 * sin(pose.pitch)
        let z2 = y * sin(pose.pitch) + z1 * cos(pose.pitch)
        let factor = distance / max(distance * 0.2, distance + z2) * pose.scale
        return CGPoint(x: Double(pivot.x) + x1 * factor, y: Double(pivot.y) + y2 * factor)
    }

    /// `layer` (whose extent must be `rect`) turned by `pose` about the canvas centre.
    static func apply(_ layer: CIImage, rect: CGRect, pose: Pose, canvas: CGSize) -> CIImage {
        let pivot = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
        let distance = 2.2 * Double(max(canvas.width, canvas.height))
        let corner = { (x: CGFloat, y: CGFloat) in CIVector(cgPoint: project(CGPoint(x: x, y: y), pose: pose, pivot: pivot, distance: distance)) }
        return layer.applyingFilter("CIPerspectiveTransform", parameters: [
            "inputTopLeft": corner(rect.minX, rect.maxY),
            "inputTopRight": corner(rect.maxX, rect.maxY),
            "inputBottomLeft": corner(rect.minX, rect.minY),
            "inputBottomRight": corner(rect.maxX, rect.minY),
        ])
    }

    /// `image` on a clear layer exactly `rect` large, so a perspective transform maps the same corners as another
    /// layer's (the cursor turns with the picture).
    static func pin(_ image: CIImage, to rect: CGRect) -> CIImage {
        image.composited(over: CIImage(color: .clear).cropped(to: rect)).cropped(to: rect)
    }
}
