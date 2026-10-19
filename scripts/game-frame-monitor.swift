// Game-window frame delivery telemetry only: no image/audio is stored or transmitted.
import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
guard CommandLine.arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let queue = DispatchQueue(label: "noa.frame.telemetry")
func save(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    try? data.write(to: output, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
}
final class Meter: NSObject, SCStreamOutput, SCStreamDelegate {
    var intervals = [Double](), last: Double?, frames = 0, started = ProcessInfo.processInfo.systemUptime
    var stopped = false
    var signature: UInt64?, changed=0, changedLast: Double?, changeIntervals=[Double]()
    func stream(_ stream: SCStream, didStopWithError error: Error) { queue.async { self.stopped = true } }
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let a = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let n = a.first?[.status] as? Int, SCFrameStatus(rawValue: n) == .complete else { return }
        let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
        if let p = last, t > p { intervals.append((t-p)*1000) }
        last = t; frames += 1
        if let pixel = CMSampleBufferGetImageBuffer(sb) {
            CVPixelBufferLockBaseAddress(pixel,.readOnly)
            if let base = CVPixelBufferGetBaseAddress(pixel) {
                let stride = CVPixelBufferGetBytesPerRow(pixel), w=CVPixelBufferGetWidth(pixel), h=CVPixelBufferGetHeight(pixel)
                var hash: UInt64=1469598103934665603
                for y in Swift.stride(from: max(1,h/10), to:h, by:max(1,h/12)) {
                    for x in Swift.stride(from:0,to:w,by:max(1,w/20)) {
                        let v=base.load(fromByteOffset:y*stride+x*4,as:UInt32.self)
                        hash=(hash ^ UInt64(v)) &* 1099511628211
                    }
                }
                if signature != hash { changed += 1; if let p=changedLast {changeIntervals.append((t-p)*1000)}; changedLast=t; signature=hash }
            }
            CVPixelBufferUnlockBaseAddress(pixel,.readOnly)
        }
    }
    func snapshot(_ window: SCWindow) -> [String: Any] {
        let now = ProcessInfo.processInfo.systemUptime, duration = now-started
        let sorted = intervals.sorted()
        let p95: Any = sorted.isEmpty ? NSNull() : sorted[min(sorted.count-1, Int(Double(sorted.count)*0.95))]
        let changeSorted=changeIntervals.sorted()
        let changeP95: Any=changeSorted.isEmpty ? NSNull() : changeSorted[min(changeSorted.count-1,Int(Double(changeSorted.count)*0.95))]
        var result: [String: Any] = ["at": Date().timeIntervalSince1970*1000, "state": "measuring", "basis": "ScreenCaptureKit complete game-window frames; not engine FPS", "fps": Double(frames)/max(duration,0.001), "windowSeconds": duration, "p95Ms": p95, "maxMs": sorted.last as Any? ?? NSNull(), "gaps100ms": intervals.filter {$0 > 100}.count, "idleMs": last == nil ? NSNull() : max(0,(now-last!)*1000), "windowId": window.windowID, "width": window.frame.width, "height": window.frame.height, "captureLimitFps":60]
        result["changedFps"]=Double(changed)/max(duration,0.001)
        result["changedP95Ms"]=changeP95
        result["changedGaps100ms"]=changeIntervals.filter {$0 > 100}.count
        result["unchangedMs"]=changedLast == nil ? NSNull() : max(0,(now-changedLast!)*1000)
        changed=0; changeIntervals.removeAll(keepingCapacity:true)
        intervals.removeAll(keepingCapacity:true); frames=0; started=now
        return result
    }
}
func find() async -> SCWindow? {
    guard let c = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly:false) else { return nil }
    return c.windows.filter {$0.owningApplication?.applicationName == "Vampire Survivors" && $0.title == "Vampire Survivors" && $0.frame.width >= 320}.max {$0.frame.width*$0.frame.height < $1.frame.width*$1.frame.height}
}
var running = true
func run() async {
    while running {
        guard let window = await find() else { save(["at":Date().timeIntervalSince1970*1000,"state":"window_unavailable"]); try? await Task.sleep(nanoseconds:2_000_000_000); continue }
        let meter = Meter(), cfg = SCStreamConfiguration()
        cfg.width=320; cfg.height=180; cfg.minimumFrameInterval=CMTime(value:1,timescale:60)
        cfg.showsCursor=false; cfg.pixelFormat=kCVPixelFormatType_32BGRA; cfg.queueDepth=3; cfg.capturesAudio=false
        let stream = SCStream(filter:SCContentFilter(desktopIndependentWindow:window),configuration:cfg,delegate:meter)
        do { try stream.addStreamOutput(meter,type:.screen,sampleHandlerQueue:queue); try await stream.startCapture() }
        catch { save(["at":Date().timeIntervalSince1970*1000,"state":"capture_unavailable"]); try? await Task.sleep(nanoseconds:5_000_000_000); continue }
        var count=0
        while running && !queue.sync(execute:{meter.stopped}) {
            try? await Task.sleep(nanoseconds:2_000_000_000)
            save(queue.sync {meter.snapshot(window)})
            count += 1
            if count % 5 == 0 { guard let current = await find(), current.windowID == window.windowID else { break } }
        }
        try? await stream.stopCapture()
    }
}
signal(SIGTERM,SIG_IGN)
let term=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.main)
term.setEventHandler {running=false}; term.resume()
let done=DispatchSemaphore(value:0)
Task { await run(); done.signal() }
while done.wait(timeout:.now()+0.1) == .timedOut {RunLoop.main.run(until:Date().addingTimeInterval(0.1))}
