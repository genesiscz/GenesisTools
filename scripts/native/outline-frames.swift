// Films one display region the way the window server composites it, with ONLY one app's windows in it, and logs the
// bounding box of that app's visible pixels for every new frame. This is the truth for an animated outline: a
// per-window ScreenCaptureKit recording (`tools control capture record --canvas crop`) rescales a stale image while a
// window changes size, and window-frames.swift sees only the window, not a mask animated inside it.
//
// Build:  swiftc -swift-version 5 -O scripts/native/outline-frames.swift -o <session>/outline-frames
// Run it through the app launcher, so Screen Recording is GenesisTools.app's grant and no prompt appears:
//   ~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools <session>/outline-frames \
//     <pid> <displayID> <x> <y> <w> <h> <seconds> <out-dir> [scale=0.5] [images|noimages]
//   x y w h: the region in display-local points, top-left origin. displayID: WidgetCoordinator.id(screen).
// It prints "started" once the first frame is recorded; send the test commands after that (scripts/native/widget-drive.ts).
// A pid with no shareable window exits 3 before any capture. A run that has not finished <seconds> + 20 s after it
// started exits 4: discovery, start and stop wait on the window server with no timeout of their own.
// Output: <out-dir>/frames.txt, one line per frame: "<index> <ms since first frame> bbox=minX,minY,maxX,maxY" in
// output pixels (divide by scale for points), and <out-dir>/<index>.jpg unless "noimages".
// The background stays black (SCStreamConfiguration.backgroundColor traps in SCStream.init on macOS 26.3); a pixel
// counts as the app's when its green channel is above 12, which the dark widget glass is and black plus shadow is not.
// Frames arrive only when the composite changes, about every 28-35 ms here: a sampling rate, not the display's.
import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

let args = CommandLine.arguments

/// Every bad argument stops here with exit 2, before the output folder or the stream exists: a NaN or an infinity
/// would otherwise trap at the pixel-size conversion, and a zero size or a negative time would reach ScreenCaptureKit.
func usage(_ problem: String) -> Never {
    FileHandle.standardError.write(Data((problem + "\n"
        + "usage: outline-frames <pid> <displayID> <x> <y> <w> <h> <seconds> <out-dir> [scale] [images|noimages]\n").utf8))
    exit(2)
}

guard args.count >= 9, let pid = Int32(args[1]), let displayID = UInt32(args[2]),
    let x = Double(args[3]), let y = Double(args[4]), let w = Double(args[5]), let h = Double(args[6]),
    let seconds = Double(args[7])
else { usage("missing or unreadable arguments") }
let outdir = args[8]
let scaleArgument = args.count > 9 ? args[9] : "0.5"
guard let scale = Double(scaleArgument), scale.isFinite, scale > 0, scale <= 4 else {
    usage("scale must be a number above 0 and at most 4, got \(scaleArgument)")
}
guard x.isFinite, y.isFinite else { usage("x and y must be finite numbers") }
guard w.isFinite, h.isFinite, w > 0, h > 0 else { usage("w and h must be positive numbers") }
guard seconds.isFinite, seconds > 0, seconds <= 3600 else { usage("seconds must be above 0 and at most 3600") }
let outputWidth = (w * scale).rounded(.down)
let outputHeight = (h * scale).rounded(.down)
guard (1...16_384).contains(outputWidth), (1...16_384).contains(outputHeight) else {
    usage("w and h times the scale must give 1 to 16384 output pixels, got \(outputWidth) x \(outputHeight)")
}
if args.count > 10, !["images", "noimages"].contains(args[10]) {
    usage("the last argument is images or noimages, got \(args[10])")
}
let saveImages = args.count > 10 ? args[10] != "noimages" : true
do {
    try FileManager.default.createDirectory(atPath: outdir, withIntermediateDirectories: true)
} catch {
    FileHandle.standardError.write(Data("cannot create \(outdir): \(error)\n".utf8))
    exit(2)
}

final class Recorder: NSObject, SCStreamOutput {
    let outdir: String
    let context = CIContext()
    var index = 0
    var first: Double?
    var log = ""
    /// Runs once, on the sample queue, after the first complete frame is logged: "started" means the film has begun.
    var onFirstFrame: (() -> Void)?

    init(outdir: String) { self.outdir = outdir }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
            let buffer = CMSampleBufferGetImageBuffer(sample)
        else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        let start = first ?? time
        first = start
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var minX = width, minY = height, maxX = -1, maxY = -1
        if let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
            for row in 0..<height {
                let line = base + row * stride
                for column in 0..<width where line[column * 4 + 1] > 12 {
                    minX = min(minX, column)
                    maxX = max(maxX, column)
                    minY = min(minY, row)
                    maxY = max(maxY, row)
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        log += String(format: "%04d %9.2f bbox=%d,%d,%d,%d\n", index, (time - start) * 1000, minX, minY, maxX, maxY)
        if saveImages, let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
            let data = context.jpegRepresentation(of: CIImage(cvPixelBuffer: buffer), colorSpace: colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7])
        {
            do {
                try data.write(to: URL(fileURLWithPath: outdir + String(format: "/%04d.jpg", index)))
            } catch {
                FileHandle.standardError.write(Data("frame \(index): \(error)\n".utf8))
            }
        }
        if index == 0 {
            onFirstFrame?()
            onFirstFrame = nil
        }
        index += 1
    }
}

let recorder = Recorder(outdir: outdir)
// One deadline for the whole run, so a window server that stops answering ends the run instead of hanging it.
let runDeadline = seconds + 20
DispatchQueue.main.asyncAfter(deadline: .now() + runDeadline) {
    FileHandle.standardError.write(Data("capture did not finish within \(runDeadline) s; ScreenCaptureKit stopped answering\n".utf8))
    exit(4)
}
Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            FileHandle.standardError.write(Data("no display \(displayID)\n".utf8))
            exit(3)
        }
        let windows = content.windows.filter { $0.owningApplication?.processID == pid }
        // With no window of the app in the filter every frame is black, and the log would look like a hidden widget.
        guard !windows.isEmpty else {
            FileHandle.standardError.write(Data("pid \(pid) has no shareable windows (wrong pid, or the app is not running)\n".utf8))
            exit(3)
        }
        let filter = SCContentFilter(display: display, including: windows)
        let config = SCStreamConfiguration()
        config.sourceRect = CGRect(x: x, y: y, width: w, height: h)
        config.width = Int(outputWidth)
        config.height = Int(outputHeight)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 240)
        config.queueDepth = 8
        config.showsCursor = false
        config.pixelFormat = kCVPixelFormatType_32BGRA
        // Created on the main actor: the verified working setup (a custom backgroundColor trapped in this init).
        let stream = await MainActor.run { SCStream(filter: filter, configuration: config, delegate: nil) }
        let samples = DispatchQueue(label: "outline-frames")
        // A command sent before the first frame would animate before the film starts.
        let filmed = windows.count
        recorder.onFirstFrame = {
            print("started windows=\(filmed)")
            fflush(stdout)
        }
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: samples)
        try await stream.startCapture()
        try await Task.sleep(for: .seconds(seconds))
        try await stream.stopCapture()
        // stopCapture ends new deliveries but does not wait for a callback already running on the sample queue,
        // which writes `log` and `index`: read both there, after it.
        let (log, count) = samples.sync { (recorder.log, recorder.index) }
        try log.write(toFile: outdir + "/frames.txt", atomically: true, encoding: .utf8)
        print("frames=\(count)")
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("error: \(error)\n".utf8))
        exit(1)
    }
}
RunLoop.main.run()
