import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Annotate + OCR

let INTERACTABLE_ROLES: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXLink", "AXMenuButton", "AXComboBox",
    "AXSearchField", "AXSlider", "AXDisclosureTriangle", "AXIncrementor",
]

struct FramedElement {
    let el: AXUIElement
    let role: String
    let frame: CGRect  // global CG points
}

func collectFramedElements(_ root: AXUIElement, all: Bool, depth: Int = 0, maxDepth: Int = 15) -> [FramedElement] {
    if depth > maxDepth { return [] }
    var out: [FramedElement] = []
    if let role = axStringAttribute(root, "AXRole"),
       all ? true : INTERACTABLE_ROLES.contains(role),
       let pos = axPointValue(root, "AXPosition"),
       let size = axSizeValue(root, "AXSize"),
       size.width > 1, size.height > 1 {
        if all {
            if axStringAttribute(root, "AXIdentifier") != nil ||
               axStringAttribute(root, "AXDescription") != nil ||
               axStringAttribute(root, "AXTitle") != nil {
                out.append(FramedElement(el: root, role: role,
                    frame: CGRect(origin: pos, size: size)))
            }
        } else {
            out.append(FramedElement(el: root, role: role, frame: CGRect(origin: pos, size: size)))
        }
    }
    for child in axChildren(root) {
        out.append(contentsOf: collectFramedElements(child, all: all, depth: depth + 1, maxDepth: maxDepth))
    }
    return out
}

func annotateImage(_ image: CGImage, appName: String, pid: pid_t, windowTitle: String,
                    windowBoundsPts: CGRect) -> (CGImage, [[String: Any]]) {
    let app = AXUIElementCreateApplication(pid)
    // Match the AX window to the CAPTURED window by FRAME, not just title —
    // title-mismatch + .first fallback annotated a phantom translate popup's
    // elements onto a screenshot of the real window (blind-test 4D).
    var axWin: AXUIElement? = nil
    for w in axWindows(app) {
        guard let pos = axPointValue(w, "AXPosition"), let size = axSizeValue(w, "AXSize") else { continue }
        if abs(pos.x - windowBoundsPts.origin.x) < 6 && abs(pos.y - windowBoundsPts.origin.y) < 6 &&
           abs(size.width - windowBoundsPts.width) < 6 && abs(size.height - windowBoundsPts.height) < 6 {
            axWin = w
            break
        }
    }
    if axWin == nil && !windowTitle.isEmpty {
        for w in axWindows(app) {
            if (axStringAttribute(w, "AXTitle") ?? "") == windowTitle { axWin = w; break }
        }
    }
    // No frame/title match: better zero annotations than another window's boxes.
    guard let win = axWin else { return (image, []) }

    let all = args.contains("--all")
    let elements = collectFramedElements(win, all: all)
    let scale = CGFloat(image.width) / windowBoundsPts.width

    let width = image.width
    let height = image.height
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        return (image, [])
    }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    var legend: [[String: Any]] = []
    var n = 0
    for fe in elements {
        // element global pts -> window-relative pts -> image px (top-left origin)
        let rx = (fe.frame.origin.x - windowBoundsPts.origin.x) * scale
        let ryTop = (fe.frame.origin.y - windowBoundsPts.origin.y) * scale
        let rw = fe.frame.width * scale
        let rh = fe.frame.height * scale
        // Skip boxes with no meaningful visible portion — a sliver at the image
        // edge gets a legend number but no readable box (blind-test 3A, n:10).
        let visible = CGRect(x: rx, y: ryTop, width: rw, height: rh)
            .intersection(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        if visible.isNull || visible.width < 10 || visible.height < 10 ||
           (rw * rh > 0 && visible.width * visible.height / (rw * rh) < 0.3) { continue }
        n += 1
        // CGContext origin is bottom-left — flip Y
        let ryCG = CGFloat(height) - ryTop - rh
        let rect = CGRect(x: rx, y: ryCG, width: rw, height: rh)
        ctx.setStrokeColor(CGColor(red: 1, green: 0.1, blue: 0.5, alpha: 0.9))
        ctx.setLineWidth(2)
        ctx.stroke(rect)

        let label = "\(n)"
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 22, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
        ]
        let astr = NSAttributedString(string: label, attributes: attrs)
        let line = CTLineCreateWithAttributedString(astr)
        let tb = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        let pad: CGFloat = 3
        let bgRect = CGRect(x: rect.minX, y: rect.maxY - tb.height - 2 * pad,
                            width: tb.width + 2 * pad, height: tb.height + 2 * pad)
        ctx.setFillColor(CGColor(red: 1, green: 0.1, blue: 0.5, alpha: 0.9))
        ctx.fill(bgRect)
        ctx.textPosition = CGPoint(x: bgRect.minX + pad, y: bgRect.minY + pad)
        CTLineDraw(line, ctx)

        // Legend reports the VISIBLE portion — a box crossing the image edge
        // must not claim pixels the PNG doesn't have.
        var entry: [String: Any] = ["n": n, "role": fe.role,
            "px": ["x": Int(visible.origin.x), "y": Int(visible.origin.y),
                   "w": Int(visible.width), "h": Int(visible.height)]]
        if visible.width < rw - 1 || visible.height < rh - 1 {
            entry["clipped"] = true
        }
        entry.merge(elementInfo(fe.el)) { _, new in new }
        legend.append(entry)
    }
    let annotated = ctx.makeImage() ?? image
    return (annotated, legend)
}

func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        errorExit("cannot create image file at \(path)")
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) { errorExit("failed to write PNG to \(path)") }
}

func runOCR(on image: CGImage) -> [String: Any] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch {
        errorExit("OCR failed: \(error.localizedDescription)")
    }
    let W = CGFloat(image.width)
    let H = CGFloat(image.height)
    var blocks: [[String: Any]] = []
    var lines: [String] = []
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox  // normalized, origin bottom-left
        blocks.append([
            "text": cand.string,
            "confidence": Double(cand.confidence),
            "px": ["x": Int(bb.minX * W), "y": Int((1 - bb.maxY) * H),
                    "w": Int(bb.width * W), "h": Int(bb.height * H)],
        ])
        lines.append(cand.string)
    }
    return ["ok": true, "action": "ocr", "blocks": blocks, "count": blocks.count,
            "text": lines.joined(separator: "\n"),
            "note": "px coords are pixels of the source image, origin top-left"]
}

func loadCGImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        errorExit("cannot read image: \(path)")
    }
    return img
}

func cmdOcr(appName: String?) {
    var image: CGImage
    if let imgPath = argValue("--image") {
        image = loadCGImage(imgPath)
    } else if let appName = appName {
        let (img, _, _, _) = captureWindowCGImage(appName)
        image = img
    } else {
        errorExit("ocr needs --image <path> or --app <name>")
    }
    if let cropStr = argValue("--crop") {
        let pcs = cropStr.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        guard pcs.count == 4 else { errorExit("--crop format: x,y,w,h (pixels of the image)") }
        guard let cropped = image.cropping(to: CGRect(x: pcs[0], y: pcs[1], width: pcs[2], height: pcs[3])) else {
            errorExit("--crop outside image bounds \(image.width)x\(image.height)")
        }
        image = cropped
    }
    jsonOutput(runOCR(on: image))
}
