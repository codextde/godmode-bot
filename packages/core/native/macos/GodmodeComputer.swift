// godmode-computer — macOS helper for Godmode's computer use.
//
// Speaks JSON lines on stdin/stdout: `{"id":1,"cmd":"displays"}` → `{"id":1,"ok":true,"result":[…]}`.
// It lists displays and windows, captures a display or a single window (ScreenCaptureKit), and sends mouse and
// keyboard input either globally (the real cursor moves — "desktop" mode) or straight to one app's process
// (`pid` set — "window" mode): events are posted with CGEventPostToPid, so the cursor stays where the human left it
// and the app is not brought to the front. Controls that track the real mouse (NSButton & co.) are pressed through
// the Accessibility API instead.
//
// Needs Accessibility (input) and Screen Recording (capture, window titles) permission for the app that runs it.
// Built by packages/core/scripts/build.ts (embedded into the core) or on demand in development.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

let HELPER_VERSION = "3"

// MARK: - Output

let outputLock = NSLock()

func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  data.append(0x0A)
  outputLock.lock()
  defer { outputLock.unlock() }
  // write(2), not FileHandle.write: that raises an Objective-C exception (a crash report) when the core is gone.
  let ok = data.withUnsafeBytes { buf -> Bool in
    var offset = 0
    while offset < buf.count {
      let n = write(STDOUT_FILENO, buf.baseAddress! + offset, buf.count - offset)
      if n < 0 {
        if errno == EINTR { continue }
        if errno == EAGAIN {
          usleep(1_000)
          continue
        }
        return false
      }
      offset += n
    }
    return true
  }
  // The core went away: nothing is listening anymore. (_exit: no atexit handlers racing AppKit on another thread.)
  if !ok { _exit(0) }
}

struct HelperError: Error {
  let message: String
  let code: String
  init(_ message: String, code: String = "failed") {
    self.message = message
    self.code = code
  }
}

// MARK: - Params

struct Params {
  let raw: [String: Any]
  func double(_ key: String) -> Double? {
    if let n = raw[key] as? NSNumber { return n.doubleValue }
    return nil
  }
  func int(_ key: String) -> Int? {
    if let n = raw[key] as? NSNumber { return n.intValue }
    return nil
  }
  func string(_ key: String) -> String? { raw[key] as? String }
  func bool(_ key: String) -> Bool? { (raw[key] as? NSNumber)?.boolValue }
  func strings(_ key: String) -> [String] { (raw[key] as? [Any])?.compactMap { $0 as? String } ?? [] }
  func requireDouble(_ key: String) throws -> Double {
    guard let v = double(key), v.isFinite else { throw HelperError("Missing number \"\(key)\"", code: "bad_request") }
    return v
  }
  func requireInt(_ key: String) throws -> Int {
    guard let v = int(key) else { throw HelperError("Missing integer \"\(key)\"", code: "bad_request") }
    return v
  }
}

// MARK: - Permissions

func permissions() -> [String: Any] {
  ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}

func requestPermissions(_ p: Params) -> [String: Any] {
  if p.bool("accessibility") ?? true, !AXIsProcessTrusted() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  }
  if p.bool("screenRecording") ?? true, !CGPreflightScreenCaptureAccess() {
    _ = CGRequestScreenCaptureAccess()
  }
  return permissions()
}

// MARK: - Displays

func displayName(_ id: CGDirectDisplayID) -> String {
  for screen in NSScreen.screens {
    if let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
      return screen.localizedName
    }
  }
  return CGDisplayIsBuiltin(id) != 0 ? "Built-in Display" : "Display \(id)"
}

func displayScale(_ id: CGDirectDisplayID) -> Double {
  if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
    return Double(mode.pixelWidth) / Double(mode.width)
  }
  return 1
}

func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  return Array(ids.prefix(Int(count)))
}

func displays() -> [[String: Any]] {
  let main = CGMainDisplayID()
  return activeDisplays().map { id in
    let b = CGDisplayBounds(id)
    return [
      "id": Int(id),
      "name": displayName(id),
      "x": Double(b.origin.x),
      "y": Double(b.origin.y),
      "width": Double(b.width),
      "height": Double(b.height),
      "scale": displayScale(id),
      "primary": id == main,
    ]
  }
}

// MARK: - Windows

func windowInfoList(all: Bool) -> [[String: Any]] {
  let options: CGWindowListOption = all ? [.optionAll, .excludeDesktopElements] : [.optionOnScreenOnly, .excludeDesktopElements]
  return (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
}

let ignoredOwners: Set<String> = ["Window Server", "Dock", "Control Center", "Notification Center", "SystemUIServer", "Spotlight", "WindowManager"]

func describeWindow(_ w: [String: Any], frontmostPid: pid_t?) -> [String: Any]? {
  guard let number = w[kCGWindowNumber as String] as? NSNumber,
        let pidNum = w[kCGWindowOwnerPID as String] as? NSNumber,
        let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDict)
  else { return nil }
  let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
  let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
  let pid = pid_t(pidNum.int32Value)
  let app = NSRunningApplication(processIdentifier: pid)
  return [
    "id": number.intValue,
    "pid": Int(pid),
    "app": app?.localizedName ?? owner,
    "bundleId": app?.bundleIdentifier ?? NSNull(),
    "title": (w[kCGWindowName as String] as? String) ?? "",
    "x": Double(bounds.origin.x),
    "y": Double(bounds.origin.y),
    "width": Double(bounds.width),
    "height": Double(bounds.height),
    "layer": layer,
    "onScreen": (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
    "frontmost": frontmostPid == pid,
  ]
}

func windows(_ p: Params) -> [[String: Any]] {
  let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
  let own = ProcessInfo.processInfo.processIdentifier
  var out: [[String: Any]] = []
  for w in windowInfoList(all: p.bool("all") ?? false) {
    guard let d = describeWindow(w, frontmostPid: frontmost) else { continue }
    if (d["layer"] as? Int) != 0 || (d["pid"] as? Int) == Int(own) { continue }
    if ignoredOwners.contains((d["app"] as? String) ?? "") { continue }
    if let alpha = (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha <= 0.01 { continue }
    if ((d["width"] as? Double) ?? 0) < 60 || ((d["height"] as? Double) ?? 0) < 40 { continue }
    if let app = NSRunningApplication(processIdentifier: pid_t((d["pid"] as? Int) ?? 0)), app.activationPolicy == .prohibited { continue }
    out.append(d)
  }
  return out
}

func windowById(_ id: Int) -> [String: Any]? {
  let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
  guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]], let w = list.first else { return nil }
  guard let d = describeWindow(w, frontmostPid: frontmost), (d["id"] as? Int) == id else { return nil }
  return d
}

func apps() -> [[String: Any]] {
  let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
  return NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular }
    .map {
      [
        "pid": Int($0.processIdentifier),
        "name": $0.localizedName ?? "",
        "bundleId": $0.bundleIdentifier ?? NSNull(),
        "active": $0.processIdentifier == frontmost,
        "hidden": $0.isHidden,
      ]
    }
}

// MARK: - Capture

final class ShareableCache {
  private var content: AnyObject?
  private var fetchedAt = Date.distantPast
  private let lock = NSLock()

  private func cached() -> AnyObject? {
    lock.lock()
    defer { lock.unlock() }
    return Date().timeIntervalSince(fetchedAt) < 2 ? content : nil
  }

  private func store(_ value: AnyObject) {
    lock.lock()
    defer { lock.unlock() }
    content = value
    fetchedAt = Date()
  }

  @available(macOS 12.3, *)
  func get(refresh: Bool) async throws -> SCShareableContent {
    if !refresh, let c = cached() as? SCShareableContent { return c }
    let fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    store(fresh)
    return fresh
  }
}

let shareable = ShareableCache()

func fitSize(width: Double, height: Double, maxWidth: Double, maxHeight: Double, maxScale: Double) -> (Int, Int) {
  let scale = min(maxWidth / width, maxHeight / height, maxScale)
  return (max(1, Int((width * scale).rounded())), max(1, Int((height * scale).rounded())))
}

func encode(_ image: CGImage, format: String, quality: Double) throws -> String {
  let data = NSMutableData()
  let type = (format == "png" ? UTType.png : UTType.jpeg).identifier as CFString
  guard let dest = CGImageDestinationCreateWithData(data, type, 1, nil) else { throw HelperError("Could not encode the image") }
  let props = [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary
  CGImageDestinationAddImage(dest, image, format == "png" ? nil : props)
  guard CGImageDestinationFinalize(dest) else { throw HelperError("Could not encode the image") }
  return (data as Data).base64EncodedString()
}

func scaled(_ image: CGImage, width: Int, height: Int) -> CGImage {
  if image.width == width && image.height == height { return image }
  guard let ctx = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
  ) else { return image }
  ctx.interpolationQuality = .high
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return ctx.makeImage() ?? image
}

/// Resolves a continuation exactly once (a result or a timeout, whichever comes first).
final class Once: @unchecked Sendable {
  private var done = false
  private let lock = NSLock()
  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if done { return false }
    done = true
    return true
  }
}

/// Run `op`, giving up after `seconds`. Unlike a task group this never waits for a hung operation to finish.
func withTimeout<T>(_ seconds: Double, _ op: @escaping () async throws -> T) async throws -> T {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
    let once = Once()
    Task {
      do {
        let value = try await op()
        if once.claim() { cont.resume(returning: value) }
      } catch {
        if once.claim() { cont.resume(throwing: error) }
      }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
      if once.claim() { cont.resume(throwing: HelperError("ScreenCaptureKit did not answer", code: "sck_timeout")) }
    }
  }
}

/// macOS can hold ScreenCaptureKit requests of a binary indefinitely (e.g. while its screen-capture consent is
/// pending or was dismissed). After a stall, captures use /usr/sbin/screencapture for a while.
let sckLock = NSLock()
var sckStalledUntil = Date.distantPast

func sckUsable() -> Bool {
  sckLock.lock()
  defer { sckLock.unlock() }
  return Date() >= sckStalledUntil
}

func markSckStalled() {
  sckLock.lock()
  sckStalledUntil = Date().addingTimeInterval(60)
  sckLock.unlock()
}

/// ScreenCaptureKit capture of a window or display at `size` pixels (nil = native resolution).
@available(macOS 14.0, *)
func sckImage(window windowId: Int?, display displayId: CGDirectDisplayID, frame: CGRect, size: (Int, Int)?, cursor: Bool) async throws -> CGImage {
  let filter: SCContentFilter
  if let windowId {
    var content = try await shareable.get(refresh: false)
    var scWindow = content.windows.first { Int($0.windowID) == windowId }
    if scWindow == nil {
      content = try await shareable.get(refresh: true)
      scWindow = content.windows.first { Int($0.windowID) == windowId }
    }
    guard let w = scWindow else { throw HelperError("The window is gone (closed or minimized).", code: "window_gone") }
    filter = SCContentFilter(desktopIndependentWindow: w)
  } else {
    var content = try await shareable.get(refresh: false)
    var scDisplay = content.displays.first { $0.displayID == displayId }
    if scDisplay == nil {
      content = try await shareable.get(refresh: true)
      scDisplay = content.displays.first { $0.displayID == displayId }
    }
    guard let d = scDisplay else { throw HelperError("Display \(displayId) is not connected.", code: "display_gone") }
    // Leave out the agent cursor (sharingType .none doesn't hide windows from ScreenCaptureKit on every macOS) — with
    // fresh content when the cached list predates its panel.
    let cursorWindow = agentCursorWindowNumber()
    if cursorWindow != 0 && !content.windows.contains(where: { Int($0.windowID) == cursorWindow }) {
      content = try await shareable.get(refresh: true)
    }
    let own = ProcessInfo.processInfo.processIdentifier
    filter = SCContentFilter(display: d, excludingWindows: content.windows.filter { $0.owningApplication?.processID == own })
  }
  let scale = Double(filter.pointPixelScale)
  let config = SCStreamConfiguration()
  config.showsCursor = cursor
  config.ignoreShadowsSingleWindow = true
  config.captureResolution = .best
  config.colorSpaceName = CGColorSpace.sRGB
  config.width = size?.0 ?? max(1, Int((frame.width * scale).rounded()))
  config.height = size?.1 ?? max(1, Int((frame.height * scale).rounded()))
  return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

/// /usr/sbin/screencapture of a window (-l) or a screen rect in global points (-R), at native resolution. Waits on the
/// process's termination handler, never blocking a Swift concurrency thread.
func screencaptureImage(window windowId: Int?, frame: CGRect, cursor: Bool) async throws -> CGImage {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("godmode-capture-\(UUID().uuidString).png")
  defer { try? FileManager.default.removeItem(at: url) }
  var args = ["-x", "-t", "png"]
  if cursor { args.append("-C") }
  if let windowId {
    args += ["-o", "-l\(windowId)"]
  } else {
    args.append("-R\(Int(frame.minX.rounded())),\(Int(frame.minY.rounded())),\(Int(frame.width.rounded())),\(Int(frame.height.rounded()))")
  }
  args.append(url.path)
  let proc = Process()
  proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  proc.arguments = args
  proc.standardOutput = FileHandle.nullDevice
  proc.standardError = FileHandle.nullDevice
  let status: Int32 = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Int32, Error>) in
    let once = Once()
    proc.terminationHandler = { p in if once.claim() { cont.resume(returning: p.terminationStatus) } }
    do {
      try proc.run()
    } catch {
      if once.claim() { cont.resume(throwing: error) }
      return
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
      guard once.claim() else { return }
      proc.terminate()
      cont.resume(throwing: HelperError("Taking a screenshot timed out. Check System Settings → Privacy & Security → Screen & System Audio Recording.", code: "failed"))
    }
  }
  guard status == 0,
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    throw HelperError(windowId != nil ? "The window can't be captured (closed or minimized)." : "Taking a screenshot failed.", code: windowId != nil ? "window_gone" : "failed")
  }
  return image
}

/// Capture a display or a window. `rx/ry/rw/rh` (global points) crop to a region at full resolution (zoom).
func capture(_ p: Params) async throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else {
    throw HelperError("Screen Recording permission is missing. Allow Godmode in System Settings → Privacy & Security → Screen & System Audio Recording.", code: "permission_screen")
  }
  let maxWidth = p.double("maxWidth") ?? 1456
  let maxHeight = p.double("maxHeight") ?? 1456
  let format = p.string("format") ?? "jpeg"
  let quality = p.double("quality") ?? 0.7
  let cursor = p.bool("cursor") ?? false

  let windowId = p.int("window")
  let displayId = p.int("display").map { CGDirectDisplayID($0) } ?? CGMainDisplayID()
  var frame: CGRect
  if let windowId {
    guard let info = windowById(windowId),
          let x = info["x"] as? Double, let y = info["y"] as? Double, let w = info["width"] as? Double, let h = info["height"] as? Double
    else { throw HelperError("The window is gone.", code: "window_gone") }
    frame = CGRect(x: x, y: y, width: w, height: h)
  } else {
    guard activeDisplays().contains(displayId) else { throw HelperError("Display \(displayId) is not connected.", code: "display_gone") }
    frame = CGDisplayBounds(displayId)
  }

  var crop: CGRect? = nil
  if let rx = p.double("rx"), let ry = p.double("ry"), let rw = p.double("rw"), let rh = p.double("rh"), rw > 0, rh > 0 {
    let region = CGRect(x: rx, y: ry, width: rw, height: rh).intersection(frame)
    guard !region.isNull, region.width >= 1, region.height >= 1 else { throw HelperError("The zoom region is outside the shared area.", code: "bad_request") }
    crop = region
  }

  // Native resolution when cropping or falling back; ScreenCaptureKit scales directly otherwise.
  var image: CGImage? = nil
  if #available(macOS 14.0, *), sckUsable() {
    let scale = windowId == nil ? displayScale(displayId) : 2
    let size: (Int, Int)? = crop == nil ? fitSize(width: frame.width, height: frame.height, maxWidth: maxWidth, maxHeight: maxHeight, maxScale: scale) : nil
    let f = frame
    do {
      image = try await withTimeout(4) { try await sckImage(window: windowId, display: displayId, frame: f, size: size, cursor: cursor) }
    } catch let e as HelperError where e.code == "sck_timeout" {
      markSckStalled()
    } catch let e as HelperError where e.code == "window_gone" || e.code == "display_gone" {
      throw e
    } catch {
      // Declined/unavailable ScreenCaptureKit: try the screencapture tool below.
    }
  }
  if image == nil { image = try await screencaptureImage(window: windowId, frame: frame, cursor: cursor) }
  guard var result = image else { throw HelperError("Taking a screenshot failed.", code: "failed") }

  var outFrame = frame
  if let region = crop {
    let sx = Double(result.width) / frame.width
    let sy = Double(result.height) / frame.height
    let px = CGRect(x: (region.minX - frame.minX) * sx, y: (region.minY - frame.minY) * sy, width: region.width * sx, height: region.height * sy).integral
    guard let cropped = result.cropping(to: px) else { throw HelperError("Could not crop the zoom region") }
    result = cropped
    outFrame = region
  }
  // Fit the limits (a no-op when ScreenCaptureKit already produced the right size).
  let pxPerPoint = Double(result.width) / outFrame.width
  let (w, h) = fitSize(width: outFrame.width, height: outFrame.height, maxWidth: maxWidth, maxHeight: maxHeight, maxScale: pxPerPoint)
  if w != result.width || h != result.height { result = scaled(result, width: w, height: h) }

  return [
    "data": try encode(result, format: format, quality: quality),
    "format": format,
    "width": result.width,
    "height": result.height,
    "x": Double(outFrame.origin.x),
    "y": Double(outFrame.origin.y),
    "pointWidth": Double(outFrame.width),
    "pointHeight": Double(outFrame.height),
  ]
}

// MARK: - Keyboard

let namedKeys: [String: Int] = [
  "enter": kVK_Return, "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "backspace": kVK_Delete,
  "delete": kVK_ForwardDelete, "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow,
  "up": kVK_UpArrow, "down": kVK_DownArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp,
  "pagedown": kVK_PageDown, "capslock": kVK_CapsLock, "help": kVK_Help, "insert": kVK_Help,
  "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7,
  "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12, "f13": kVK_F13,
  "f14": kVK_F14, "f15": kVK_F15, "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19,
  "f20": kVK_F20, "kpenter": kVK_ANSI_KeypadEnter,
  "volumeup": kVK_VolumeUp, "volumedown": kVK_VolumeDown, "mute": kVK_Mute,
]

let modifierKeys: [String: (Int, CGEventFlags)] = [
  "cmd": (kVK_Command, .maskCommand),
  "shift": (kVK_Shift, .maskShift),
  "alt": (kVK_Option, .maskAlternate),
  "ctrl": (kVK_Control, .maskControl),
  "fn": (kVK_Function, .maskSecondaryFn),
]

/// Character → virtual key code for the current keyboard layout (so "cmd+z" hits Z on QWERTZ too).
func layoutKeyMap() -> [String: (Int, Bool)] {
  var map: [String: (Int, Bool)] = [:]
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() ?? TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
        let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
  else { return map }
  let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
    for shift in [false, true] {
      for code in 0..<128 {
        var dead: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let mods: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()),
                                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
        guard status == noErr, length > 0 else { continue }
        let s = String(utf16CodeUnits: chars, count: length)
        if map[s] == nil { map[s] = (code, shift) }
      }
    }
  }
  return map
}

var keyMapCache: (at: Date, map: [String: (Int, Bool)])? = nil

func keyMap() -> [String: (Int, Bool)] {
  if let c = keyMapCache, Date().timeIntervalSince(c.at) < 10 { return c.map }
  // TIS must run on the main thread.
  var map: [String: (Int, Bool)] = [:]
  if Thread.isMainThread { map = layoutKeyMap() } else { DispatchQueue.main.sync { map = layoutKeyMap() } }
  keyMapCache = (Date(), map)
  return map
}

func post(_ event: CGEvent, pid: pid_t?) {
  if let pid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
}

func keyEvent(_ code: Int, down: Bool, flags: CGEventFlags, pid: pid_t?, unicode: String? = nil) {
  let source = CGEventSource(stateID: pid == nil ? .hidSystemState : .privateState)
  guard let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else { return }
  e.flags = flags
  if let unicode {
    var units = Array(unicode.utf16)
    e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
  }
  post(e, pid: pid)
}

func pressKey(_ p: Params) throws -> [String: Any] {
  let pid = p.int("pid").map { pid_t($0) }
  let name = (p.string("key") ?? "").lowercased()
  let action = p.string("action") ?? "press"
  if let pid, action == "press", let field = focusedWebField(pid) {
    if axWebKey(field, pid: pid, key: name, modifiers: p.strings("modifiers")) { return ["method": "ax"] }
  }
  if p.bool("webOnly") == true { return ["method": NSNull(), "chromium": pid.map(isChromiumApp) ?? false] }
  var flags: CGEventFlags = []
  var mods: [(Int, CGEventFlags)] = []
  for m in p.strings("modifiers") {
    guard let mod = modifierKeys[m] else { throw HelperError("Unknown modifier \"\(m)\"", code: "bad_request") }
    mods.append(mod)
  }
  var code: Int
  var unicode: String? = nil
  if let c = namedKeys[name] {
    code = c
  } else if let mod = modifierKeys[name], mods.isEmpty {
    // A lone modifier (e.g. "shift") pressed as a key.
    code = mod.0
  } else if let raw = p.string("key"), raw.count == 1 {
    let map = keyMap()
    if let (c, shifted) = map[raw] {
      code = c
      if shifted && !mods.contains(where: { $0.0 == kVK_Shift }) && mods.isEmpty { unicode = raw }
    } else if let (c, _) = map[raw.lowercased()] {
      code = c
    } else {
      code = 0
      unicode = raw
    }
    if mods.isEmpty && unicode == nil { unicode = raw }
  } else {
    throw HelperError("Unknown key \"\(p.string("key") ?? "")\"", code: "bad_request")
  }
  let down = action == "press" || action == "down"
  let up = action == "press" || action == "up"
  if down {
    for (mcode, mflag) in mods {
      flags.insert(mflag)
      keyEvent(mcode, down: true, flags: flags, pid: pid)
    }
    keyEvent(code, down: true, flags: flags, pid: pid, unicode: unicode)
  }
  if down && up { usleep(12_000) }
  if up {
    if !down { for (_, mflag) in mods { flags.insert(mflag) } }
    keyEvent(code, down: false, flags: flags, pid: pid, unicode: unicode)
    for (mcode, mflag) in mods.reversed() {
      flags.remove(mflag)
      keyEvent(mcode, down: false, flags: flags, pid: pid)
    }
  }
  return ["method": "event", "chromium": pid.map(isChromiumApp) ?? false]
}

func typeText(_ p: Params) throws -> [String: Any] {
  let pid = p.int("pid").map { pid_t($0) }
  guard let text = p.string("text") else { throw HelperError("Missing \"text\"", code: "bad_request") }
  if let pid, let field = focusedWebField(pid), axReplace(field, pid: pid, with: text) { return ["method": "ax"] }
  if p.bool("webOnly") == true { return ["method": NSNull(), "chromium": pid.map(isChromiumApp) ?? false] }
  let map = keyMap()
  for ch in text {
    let s = String(ch)
    if s == "\n" || s == "\r" {
      keyEvent(kVK_Return, down: true, flags: [], pid: pid)
      keyEvent(kVK_Return, down: false, flags: [], pid: pid)
    } else if s == "\t" {
      keyEvent(kVK_Tab, down: true, flags: [], pid: pid)
      keyEvent(kVK_Tab, down: false, flags: [], pid: pid)
    } else {
      // The key code helps apps that read codes (terminals, games); the unicode string carries the character.
      let (code, shifted) = map[s] ?? (0, false)
      let flags: CGEventFlags = shifted ? .maskShift : []
      keyEvent(code, down: true, flags: flags, pid: pid, unicode: s)
      keyEvent(code, down: false, flags: flags, pid: pid, unicode: s)
    }
    usleep(pid == nil ? 6_000 : 3_000)
  }
  return ["method": "event", "chromium": pid.map(isChromiumApp) ?? false]
}

// MARK: - Pointer

func mouseButton(_ name: String?) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
  switch name {
  case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
  case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
  default: return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
  }
}

func modifierFlags(_ names: [String]) -> CGEventFlags {
  var flags: CGEventFlags = []
  for n in names { if let m = modifierKeys[n] { flags.insert(m.1) } }
  return flags
}

func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, pid: pid_t?, window: Int?, clickState: Int = 1, flags: CGEventFlags = []) {
  let source = CGEventSource(stateID: pid == nil ? .hidSystemState : .privateState)
  guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
  if let window {
    e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
  }
  if !flags.isEmpty { e.flags = flags }
  post(e, pid: pid)
}

// MARK: - SkyLight (background input Chromium accepts)

/// Private SkyLight entry points — the route Cua Driver takes for background pointer input. Chromium (Chrome, Slack,
/// VS Code, every Electron app) drops synthetic mouse events that arrive through the public CGEventPostToPid or that
/// lack the target pid in field 40; SkyLight's pid route reaches the event tap Chromium listens on. Resolved at
/// runtime: on a macOS without them the public API is the fallback.
enum SkyLight {
  private typealias PostToPid = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
  private typealias SetIntField = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
  private typealias SetWindowLocation = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
  private typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
  private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
  private typealias MainConnectionID = @convention(c) () -> UInt32
  private typealias GetWindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias GetConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32

  private static let loaded = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL) != nil

  private static func sym<T>(_ name: String, _: T.Type) -> T? {
    _ = loaded
    // RTLD_DEFAULT ((void *)-2): every loaded image.
    guard let p = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
    return unsafeBitCast(p, to: T.self)
  }

  private static let postToPidFn = sym("SLEventPostToPid", PostToPid.self)
  private static let setIntFieldFn = sym("SLEventSetIntegerValueField", SetIntField.self) ?? sym("CGEventSetIntegerValueField", SetIntField.self)
  private static let setWindowLocationFn = sym("CGEventSetWindowLocation", SetWindowLocation.self)
  private static let getFrontProcessFn = sym("_SLPSGetFrontProcess", GetFrontProcess.self)
  private static let postEventRecordFn = sym("SLPSPostEventRecordTo", PostEventRecordTo.self)
  private static let mainConnectionFn = sym("CGSMainConnectionID", MainConnectionID.self)
  private static let windowOwnerFn = sym("SLSGetWindowOwner", GetWindowOwner.self)
  private static let connectionPSNFn = sym("SLSGetConnectionPSN", GetConnectionPSN.self)
  private static let processForPIDFn = sym("GetProcessForPID", GetProcessForPID.self)

  private static func raw(_ e: CGEvent) -> UnsafeMutableRawPointer { Unmanaged.passUnretained(e).toOpaque() }

  /// Raw event field — SkyLight's setter takes the private fields (40, 51, 58, …) the public enum doesn't name.
  static func set(_ e: CGEvent, _ field: UInt32, _ value: Int64) { setIntFieldFn?(raw(e), field, value) }

  static func setWindowLocation(_ e: CGEvent, _ p: CGPoint) { setWindowLocationFn?(raw(e), p) }

  /// Through SkyLight (the public route when it is missing).
  static func post(_ e: CGEvent, pid: pid_t) {
    if let f = postToPidFn { f(pid, raw(e)) } else { e.postToPid(pid) }
  }

  /// Through both routes, as Cua Driver posts moves, right clicks and drags: AppKit targets drop some SkyLight mouse
  /// events, Chromium drops public ones.
  static func postBoth(_ e: CGEvent, pid: pid_t) {
    postToPidFn?(pid, raw(e))
    e.postToPid(pid)
  }

  private static func psn(window: UInt32, pid: pid_t, into out: inout ProcessSerialNumber) -> Bool {
    if let main = mainConnectionFn, let owner = windowOwnerFn, let connectionPSN = connectionPSNFn {
      var cid: UInt32 = 0
      if owner(main(), window, &cid) == 0, cid != 0, connectionPSN(cid, &out) == 0 { return true }
    }
    return processForPIDFn.map { $0(pid, &out) == 0 } ?? false
  }

  /// The 248-byte focus (or defocus) record for `window`.
  private static func focusRecord(_ window: UInt32, focus: Bool) -> [UInt8] {
    var buf = [UInt8](repeating: 0, count: 0xF8)
    buf[0x04] = 0xF8
    buf[0x08] = 0x0D
    withUnsafeBytes(of: window.littleEndian) { for (i, b) in $0.enumerated() { buf[0x3C + i] = b } }
    buf[0x8A] = focus ? 0x01 : 0x02
    return buf
  }

  /// Make `window` its app's focused window without raising it or activating the app: Chromium only treats a click
  /// in a focused window as a user gesture. The front app gets a defocus record — `restoreFocus` hands it back.
  /// Returns whether that defocus record went out (then focus must be restored, whatever else failed).
  static func focusWithoutRaise(pid: pid_t, window: UInt32) -> Bool {
    guard let getFront = getFrontProcessFn, let postRecord = postEventRecordFn else { return false }
    var front = ProcessSerialNumber()
    var target = ProcessSerialNumber()
    guard getFront(&front) == 0, psn(window: window, pid: pid, into: &target) else { return false }
    let defocused = postRecord(&front, focusRecord(window, focus: false)) == 0
    _ = postRecord(&target, focusRecord(window, focus: true))
    return defocused
  }

  /// Undo `focusWithoutRaise`: defocus the shared window and give the human's key window (`previousWindow`, read
  /// before the click) its focus back, so their typing keeps landing where it did.
  static func restoreFocus(previousPid: pid_t, previousWindow: UInt32, targetPid: pid_t, targetWindow: UInt32) -> Bool {
    guard let postRecord = postEventRecordFn else { return false }
    var previous = ProcessSerialNumber()
    var target = ProcessSerialNumber()
    guard psn(window: previousWindow, pid: previousPid, into: &previous), psn(window: targetWindow, pid: targetPid, into: &target) else { return false }
    let defocused = postRecord(&target, focusRecord(targetWindow, focus: false)) == 0
    let focused = postRecord(&previous, focusRecord(previousWindow, focus: true)) == 0
    return defocused && focused
  }

  /// The app's focused window (accessibility), else its frontmost normal window on screen.
  static func keyWindowNumber(pid: pid_t) -> UInt32? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var ref: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &ref) == .success, let w = asElement(ref) {
      var id: CGWindowID = 0
      if _AXUIElementGetWindow(w, &id) == .success, id != 0 { return id }
    }
    for w in windowInfoList(all: false) {
      guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { continue }
      if let n = w[kCGWindowNumber as String] as? NSNumber { return n.uint32Value }
    }
    return nil
  }
}

/// The frontmost app (read on the main thread, where AppKit keeps it current).
func frontmostPid() -> pid_t? {
  if Thread.isMainThread { return NSWorkspace.shared.frontmostApplication?.processIdentifier }
  var pid: pid_t?
  DispatchQueue.main.sync { pid = NSWorkspace.shared.frontmostApplication?.processIdentifier }
  return pid
}

/// One id for all events of a gesture (field 58), so WindowServer and Chromium coalesce them.
func gestureId() -> Int64 { Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000) }

/// A mouse event addressed to one window of a background app, stamped the way Cua Driver stamps them: click state
/// (1), button number (3), subtype (7), the target pid Chromium filters on (40), the window routing fields (51, 91,
/// 92) and the gesture id (58). `phase` is field 0, which Chromium's gesture recognizer reads.
func routedEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, pid: pid_t, window: Int, gesture: Int64, clickState: Int64, subtype: Int64, windowLocation: CGPoint, phase: Int64? = nil, flags: CGEventFlags = []) -> CGEvent? {
  guard let e = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return nil }
  if let phase { SkyLight.set(e, 0, phase) }
  SkyLight.set(e, 1, clickState)
  SkyLight.set(e, 3, Int64(button.rawValue))
  SkyLight.set(e, 7, subtype)
  SkyLight.set(e, 40, Int64(pid))
  SkyLight.set(e, 51, Int64(window))
  SkyLight.set(e, 58, gesture)
  SkyLight.set(e, 91, Int64(window))
  SkyLight.set(e, 92, Int64(window))
  SkyLight.setWindowLocation(e, windowLocation)
  if !flags.isEmpty { e.flags = flags }
  return e
}

/// Background left click Chromium accepts (Cua Driver's recipe): focus the window without raising it, then a stamped
/// move to the target, an off-screen press/release that opens Chromium's user-activation gate without touching the
/// page, and the real press/release pairs — one gesture, through SkyLight. The front app's focus is handed back after.
/// Returns false when the click brought the app to the front and the human's app couldn't be given back.
func backgroundLeftClick(pid: pid_t, window: Int, at point: CGPoint, count: Int, flags: CGEventFlags) -> Bool {
  let prior = frontmostPid()
  // Only take focus from the human's window when it can be handed back.
  let priorWindow = prior.flatMap { $0 == pid ? nil : SkyLight.keyWindowNumber(pid: $0) }
  var defocused = false
  if let priorWindow, priorWindow != 0 {
    defocused = SkyLight.focusWithoutRaise(pid: pid, window: UInt32(window))
    usleep(50_000)
  }
  let gesture = gestureId()
  let offScreen = CGPoint(x: -1, y: -1)
  func send(_ type: CGEventType, _ at: CGPoint, phase: Int64, clickState: Int64) {
    guard let e = routedEvent(type, at: at, button: .left, pid: pid, window: window, gesture: gesture, clickState: clickState, subtype: 3, windowLocation: at, phase: phase, flags: flags) else { return }
    SkyLight.post(e, pid: pid)
  }
  send(.mouseMoved, point, phase: 2, clickState: 0)
  usleep(15_000)
  send(.leftMouseDown, offScreen, phase: 1, clickState: 1)
  usleep(1_000)
  send(.leftMouseUp, offScreen, phase: 2, clickState: 1)
  usleep(100_000)
  for i in 1...max(1, min(3, count)) {
    send(.leftMouseDown, point, phase: 3, clickState: Int64(i))
    usleep(1_000)
    send(.leftMouseUp, point, phase: 3, clickState: Int64(i))
    if i < count { usleep(80_000) }
  }
  guard let prior, prior != pid else { return true }
  usleep(50_000)
  if frontmostPid() == pid {
    // The click activated the app after all: give the human their app back (macOS may refuse an accessory app).
    DispatchQueue.main.sync { _ = NSRunningApplication(processIdentifier: prior)?.activate(options: []) }
    usleep(100_000)
    return frontmostPid() != pid
  }
  if defocused, let priorWindow {
    _ = SkyLight.restoreFocus(previousPid: prior, previousWindow: priorWindow, targetPid: pid, targetWindow: UInt32(window))
  }
  return true
}

/// Window-scoped right/middle click, hover, drag and wheel: stamped like the left click, window-local location,
/// through both routes (Cua Driver's recipes for these).
func routedClick(pid: pid_t, window: Int, at point: CGPoint, local: CGPoint, button: CGMouseButton, downType: CGEventType, upType: CGEventType, count: Int, flags: CGEventFlags) {
  let gesture = gestureId()
  if let move = routedEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window, gesture: gesture, clickState: 0, subtype: 3, windowLocation: local) {
    SkyLight.postBoth(move, pid: pid)
  }
  usleep(12_000)
  for i in 1...max(1, min(3, count)) {
    if let down = routedEvent(downType, at: point, button: button, pid: pid, window: window, gesture: gesture, clickState: Int64(i), subtype: 3, windowLocation: local, flags: flags) {
      SkyLight.postBoth(down, pid: pid)
    }
    usleep(28_000)
    if let up = routedEvent(upType, at: point, button: button, pid: pid, window: window, gesture: gesture, clickState: Int64(i), subtype: 3, windowLocation: local, flags: flags) {
      SkyLight.postBoth(up, pid: pid)
    }
    if i < count { usleep(80_000) }
  }
}

/// The window's top-left corner (global points), for window-local event locations.
func windowOrigin(_ window: Int) -> CGPoint? {
  guard let w = windowById(window), let x = w["x"] as? Double, let y = w["y"] as? Double else { return nil }
  return CGPoint(x: x, y: y)
}

// MARK: - Agent cursor

let agentCursorLock = NSLock()
var agentCursorWindow = 0

/// The agent cursor panel's window number (0 before it exists), for leaving it out of captures.
func agentCursorWindowNumber() -> Int {
  agentCursorLock.lock()
  defer { agentCursorLock.unlock() }
  return agentCursorWindow
}

/// The agent's pointer over a shared window, like ChatGPT's agent cursor: background input never moves the human's
/// pointer, so this shows where the agent points and clicks. A click-through panel ordered directly above the window —
/// windows the human brings forward cover it as they cover the window — kept out of captures, following the window
/// and fading out once the agent pauses. Main thread only.
final class AgentCursor {
  static let shared = AgentCursor()

  /// Sky 500, like the agent's marks in Godmode's live view.
  private static let tint = CGColor(srgbRed: 0.055, green: 0.647, blue: 0.914, alpha: 1)
  private static let idleSeconds: TimeInterval = 20

  private var panel: NSPanel?
  /// The arrow's tip sits at this layer's origin.
  private let pointer = CALayer()
  private var window = 0
  /// The window's frame (global top-left points) and the pointer in it (window-local points).
  private var frame = CGRect.zero
  private var local: CGPoint?
  private var follow: Timer?
  private var generation = 0

  private func makePanel() -> NSPanel {
    let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.ignoresMouseEvents = true
    p.isReleasedWhenClosed = false
    p.hidesOnDeactivate = false
    p.animationBehavior = .none
    p.sharingType = .none
    p.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
    agentCursorLock.lock()
    agentCursorWindow = p.windowNumber
    agentCursorLock.unlock()
    let view = NSView()
    view.wantsLayer = true
    p.contentView = view
    view.layer?.addSublayer(pointer)

    let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
    // A classic arrow, tip at the origin (layer coordinates grow upward, so the body is below it).
    let design: [(CGFloat, CGFloat)] = [(0, 0), (0, 18), (4.8, 13.8), (8, 20.6), (11, 19.3), (7.9, 12.6), (13.6, 12.6)]
    let path = CGMutablePath()
    path.addLines(between: design.map { CGPoint(x: $0.0, y: -$0.1) })
    path.closeSubpath()
    let arrow = CAShapeLayer()
    arrow.path = path
    arrow.fillColor = AgentCursor.tint
    arrow.strokeColor = CGColor.white
    arrow.lineWidth = 1.6
    arrow.lineJoin = .round
    arrow.shadowColor = CGColor.black
    arrow.shadowOpacity = 0.35
    arrow.shadowRadius = 2.5
    arrow.shadowOffset = CGSize(width: 0, height: -1)
    arrow.contentsScale = scale
    pointer.addSublayer(arrow)

    let label = CATextLayer()
    label.string = "Godmode"
    label.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    label.fontSize = 11
    label.foregroundColor = CGColor.white
    label.alignmentMode = .center
    label.contentsScale = scale
    let width = ceil(("Godmode" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold)]).width) + 14
    let pill = CALayer()
    pill.backgroundColor = AgentCursor.tint
    pill.cornerRadius = 9
    pill.frame = CGRect(x: 14, y: -38, width: width, height: 18)
    pill.shadowColor = CGColor.black
    pill.shadowOpacity = 0.25
    pill.shadowRadius = 2
    pill.shadowOffset = CGSize(width: 0, height: -1)
    label.frame = CGRect(x: 0, y: 1.5, width: width, height: 15)
    pill.addSublayer(label)
    pointer.addSublayer(pill)
    return p
  }

  /// Global top-left rect → AppKit screen rect (origin at the primary display's bottom-left).
  private func cocoa(_ r: CGRect) -> NSRect {
    NSRect(x: r.minX, y: CGDisplayBounds(CGMainDisplayID()).height - r.maxY, width: r.width, height: r.height)
  }

  private func layerPoint(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x, y: frame.height - p.y) }

  /// Match the window's frame and stacking. False when it is gone or off screen.
  @discardableResult
  private func sync() -> Bool {
    guard let panel, let w = windowById(window), (w["onScreen"] as? Bool) == true,
          let x = w["x"] as? Double, let y = w["y"] as? Double, let width = w["width"] as? Double, let height = w["height"] as? Double
    else { return false }
    let rect = CGRect(x: x, y: y, width: width, height: height)
    if rect != frame {
      frame = rect
      panel.setFrame(cocoa(rect), display: false)
      if let local {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        pointer.position = layerPoint(local)
        CATransaction.commit()
      }
    }
    panel.order(.above, relativeTo: window)
    return true
  }

  /// Glide to `global` (points) over `window`. Returns how long the glide takes (0 when the cursor just appears).
  func move(window id: Int, to global: CGPoint) -> TimeInterval {
    let panel = self.panel ?? makePanel()
    self.panel = panel
    if id != window {
      window = id
      frame = .zero
      local = nil
    }
    let visible = panel.isVisible && panel.alphaValue > 0.5
    guard sync() else {
      hide()
      return 0
    }
    let next = CGPoint(x: global.x - frame.minX, y: global.y - frame.minY)
    var duration: TimeInterval = 0
    CATransaction.begin()
    if visible, let from = local, hypot(next.x - from.x, next.y - from.y) >= 1 {
      duration = min(0.45, max(0.12, Double(hypot(next.x - from.x, next.y - from.y)) / 1500))
      CATransaction.setAnimationDuration(duration)
      CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeInEaseOut))
    } else {
      CATransaction.setDisableActions(true)
    }
    pointer.position = layerPoint(next)
    CATransaction.commit()
    local = next
    if !visible {
      panel.alphaValue = 0
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.15
        panel.animator().alphaValue = 1
      }
    }
    generation += 1
    let current = generation
    DispatchQueue.main.asyncAfter(deadline: .now() + AgentCursor.idleSeconds) { [weak self] in
      if self?.generation == current { self?.hide() }
    }
    if follow == nil {
      follow = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
        guard let self, let panel = self.panel else { return }
        if !self.sync() { panel.orderOut(nil) }
      }
    }
    return duration
  }

  /// A ring where the agent clicks.
  func pulse() {
    guard let panel, panel.isVisible, let layer = panel.contentView?.layer, let local else { return }
    let ring = CAShapeLayer()
    let r: CGFloat = 16
    ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2), transform: nil)
    ring.fillColor = AgentCursor.tint.copy(alpha: 0.18)
    ring.strokeColor = AgentCursor.tint
    ring.lineWidth = 2.5
    ring.position = layerPoint(local)
    ring.contentsScale = pointer.sublayers?.first?.contentsScale ?? 2
    layer.insertSublayer(ring, below: pointer)
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 0.3
    grow.toValue = 1.35
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [grow, fade]
    group.duration = 0.5
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    ring.opacity = 0
    CATransaction.begin()
    CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
    ring.add(group, forKey: "pulse")
    CATransaction.commit()
  }

  /// Hide the cursor (only when it is over `window`, if given — another share may have moved it since).
  func hide(window only: Int? = nil) {
    if let only, only != window { return }
    generation += 1
    follow?.invalidate()
    follow = nil
    guard let panel, panel.isVisible else { return }
    let current = generation
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.3
      panel.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      if self?.generation == current { panel.orderOut(nil) }
    })
  }
}

/// Glide the agent cursor to `point` (global) over `window` and wait for it to arrive, so input lands as it does.
func agentCursor(window: Int, to point: CGPoint) {
  var duration: TimeInterval = 0
  DispatchQueue.main.sync { duration = AgentCursor.shared.move(window: window, to: point) }
  if duration > 0 { usleep(useconds_t(duration * 1_000_000)) }
}

func agentCursorPulse() {
  DispatchQueue.main.async { AgentCursor.shared.pulse() }
}

let pressableRoles: Set<String> = [
  "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem",
  "AXDisclosureTriangle", "AXLink", "AXTab", "AXSwitch", "AXToggle", "AXIncrementor",
]

func axString(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
  return v as? String
}

func axActions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}

/// A CF value as an AXUIElement / AXValue — only after checking its type (other apps' accessibility is untrusted).
func asElement(_ v: CFTypeRef?) -> AXUIElement? {
  guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

func asAXValue(_ v: CFTypeRef?) -> AXValue? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  return (v as! AXValue)
}

func axParent(_ el: AXUIElement) -> AXUIElement? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &v) == .success else { return nil }
  return asElement(v)
}

/// Background left click on a control that tracks the real mouse (buttons, checkboxes, menus, links): AXPress.
/// Returns true when handled. Text fields, canvases and web content fall through to posted mouse events.
func axPress(pid: pid_t, at point: CGPoint) -> Bool {
  guard AXIsProcessTrusted() else { return false }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, var el = hit else { return false }
  for _ in 0..<3 {
    let role = axString(el, kAXRoleAttribute) ?? ""
    if role == "AXTextField" || role == "AXTextArea" || role == "AXWebArea" || role == "AXComboBox" || role == "AXSearchField" { return false }
    if pressableRoles.contains(role), axActions(el).contains(kAXPressAction) {
      return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
    }
    guard let parent = axParent(el) else { return false }
    el = parent
  }
  return false
}

// MARK: - Web content (Chromium-family apps)

let chromiumLock = NSLock()
/// pid → (launch date, Chromium-family?) — the launch date tells a reused pid apart.
var chromiumApps: [pid_t: (Date, Bool)] = [:]
/// pid → launch date of the process whose web accessibility was switched on.
var webAccessibilityOn: [pid_t: Date] = [:]

/// Chrome, Edge, Brave, Arc, Vivaldi, Opera and Electron apps (Slack, VS Code, …): posted mouse events don't reach
/// their web content while the window is in the background, accessibility actions do.
func isChromiumApp(_ pid: pid_t) -> Bool {
  let app = NSRunningApplication(processIdentifier: pid)
  let launched = app?.launchDate ?? .distantPast
  chromiumLock.lock()
  if let known = chromiumApps[pid], known.0 == launched {
    chromiumLock.unlock()
    return known.1
  }
  chromiumLock.unlock()
  var found = (app?.bundleIdentifier ?? "").hasPrefix("company.thebrowser.")  // Arc
  if !found, let url = app?.bundleURL,
     let names = try? FileManager.default.contentsOfDirectory(atPath: url.appendingPathComponent("Contents/Frameworks").path) {
    // "Google Chrome Framework", "Microsoft Edge Framework", "Brave Browser Framework", "Electron Framework", "Chromium
    // Embedded Framework", …
    let markers = ["Chrome", "Chromium", "Electron", "Edge", "Brave", "Vivaldi", "Opera"]
    found = names.contains { n in n.hasSuffix("Framework.framework") && markers.contains { n.contains($0) } }
  }
  chromiumLock.lock()
  chromiumApps[pid] = (launched, found)
  chromiumLock.unlock()
  return found
}

func hasWebArea(_ el: AXUIElement, depth: Int, budget: inout Int) -> Bool {
  guard depth > 0, budget > 0 else { return false }
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref) == .success, let children = ref as? [AnyObject] else { return false }
  for child in children {
    guard budget > 0, let c = asElement(child) else { continue }
    budget -= 1
    if axString(c, kAXRoleAttribute) == "AXWebArea" || hasWebArea(c, depth: depth - 1, budget: &budget) { return true }
  }
  return false
}

/// Chromium builds its web accessibility tree only once an assistive client asks (like Cua Driver, which flips
/// AXManualAccessibility, or AXEnhancedUserInterface where that isn't supported), and asynchronously: wait for it.
func ensureWebAccessibility(pid: pid_t, app: AXUIElement, window: () -> AXUIElement?) {
  let launched = NSRunningApplication(processIdentifier: pid)?.launchDate ?? .distantPast
  chromiumLock.lock()
  let done = webAccessibilityOn[pid] == launched
  chromiumLock.unlock()
  if done { return }
  let root = window() ?? app
  if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) != .success {
    _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  }
  let deadline = Date().addingTimeInterval(3)
  while Date() < deadline {
    var budget = 600
    if hasWebArea(root, depth: 14, budget: &budget) { break }
    usleep(100_000)
  }
  chromiumLock.lock()
  webAccessibilityOn[pid] = launched
  chromiumLock.unlock()
}

let textEntryRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

/// Background left click on web content in a Chromium-family app: focus the field under the point, or press the
/// element there through accessibility — Chromium turns that into a click (mousedown, mouseup, click) on it.
/// Returns the method ("ax-focus", "ax"), or nil when the point isn't on web content.
func axWebClick(pid: pid_t, window: Int, at point: CGPoint) -> String? {
  guard AXIsProcessTrusted(), isChromiumApp(pid) else { return nil }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 1.0)
  ensureWebAccessibility(pid: pid, app: app, window: { axWindow(pid: pid, windowId: window) })
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, var el = hit else { return nil }
  // The elements from the hit up to the page (none when the point isn't on a page).
  var chain: [AXUIElement] = []
  var onPage = false
  for _ in 0..<40 {
    let role = axString(el, kAXRoleAttribute) ?? ""
    if role == "AXWebArea" {
      onPage = true
      break
    }
    if role == "AXWindow" || role == "AXApplication" { break }
    chain.append(el)
    guard let parent = axParent(el) else { break }
    el = parent
  }
  guard onPage, !chain.isEmpty else { return nil }
  for e in chain.prefix(4) where textEntryRoles.contains(axString(e, kAXRoleAttribute) ?? "") {
    if AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
      // Password fields report a masked value: never rewrite them.
      rememberWebField(pid, axString(e, kAXSubroleAttribute) == "AXSecureTextField" ? nil : e)
      return "ax-focus"
    }
  }
  for e in chain where axActions(e).contains(kAXPressAction) {
    if AXUIElementPerformAction(e, kAXPressAction as CFString) == .success {
      rememberWebField(pid, nil)
      return "ax"
    }
  }
  return nil
}

// Keys posted to a background Chromium-family app don't reach its pages either (no route does on current macOS).
// Text goes into the web field a background click focused through accessibility instead: Chromium ignores
// AXSelectedText, so the field's value is rewritten with the text spliced in at the caret (the page gets an input
// event). Editing keys (backspace, delete, cmd+a) work the same way; Return can't be sent.

let webFieldLock = NSLock()
var webFields: [pid_t: AXUIElement] = [:]

func rememberWebField(_ pid: pid_t, _ field: AXUIElement?) {
  webFieldLock.lock()
  webFields[pid] = field
  pendingSelections[pid] = nil
  webFieldLock.unlock()
}

/// The web field a background click focused, while it still has the page's focus. (A background app reports no
/// focused element, so it is remembered.)
func focusedWebField(_ pid: pid_t) -> AXUIElement? {
  webFieldLock.lock()
  let field = webFields[pid]
  webFieldLock.unlock()
  guard let field else { return nil }
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(field, kAXFocusedAttribute as CFString, &ref) == .success, (ref as? Bool) == true else {
    rememberWebField(pid, nil)
    return nil
  }
  return field
}

/// A selection set on a field, with the text it was set on: the page applies it at once, but Chromium's accessibility
/// tree reports it a moment later — until then (at most a second) the helper's own record wins.
var pendingSelections: [pid_t: (field: AXUIElement, text: String, range: NSRange, at: Date)] = [:]

func axReadSelection(_ el: AXUIElement) -> NSRange? {
  var ref: CFTypeRef?
  var r = CFRange(location: 0, length: 0)
  guard AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &ref) == .success, let v = asAXValue(ref), AXValueGetValue(v, .cfRange, &r) else { return nil }
  return NSRange(location: r.location, length: r.length)
}

func axSelection(_ el: AXUIElement, pid: pid_t, text: String) -> NSRange {
  let length = (text as NSString).length
  webFieldLock.lock()
  let pending = pendingSelections[pid]
  webFieldLock.unlock()
  let reported = axReadSelection(el)
  var r = reported ?? NSRange(location: length, length: 0)
  if let pending, CFEqual(pending.field, el), pending.text == text, Date().timeIntervalSince(pending.at) < 1, reported != pending.range {
    r = pending.range
  }
  let location = max(0, min(length, r.location))
  return NSRange(location: location, length: max(0, min(length - location, r.length)))
}

func axSetSelection(_ el: AXUIElement, pid: pid_t, text: String, _ range: NSRange) {
  var r = CFRange(location: range.location, length: range.length)
  if let v = AXValueCreate(.cfRange, &r) { AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, v) }
  webFieldLock.lock()
  pendingSelections[pid] = (el, text, range, Date())
  webFieldLock.unlock()
}

/// The field's text — nil when it can't be read (then it must not be rewritten: that would drop what's in it).
func axFieldText(_ el: AXUIElement) -> String? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &ref) == .success else { return nil }
  return ref as? String
}

/// Replace `range` (default: the selection) of the field's text with `text`; the caret goes after it.
func axReplace(_ el: AXUIElement, pid: pid_t, _ range: NSRange? = nil, with text: String) -> Bool {
  guard let current = axFieldText(el) else { return false }
  let target = range ?? axSelection(el, pid: pid, text: current)
  let next = (current as NSString).replacingCharacters(in: target, with: text)
  guard AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, next as CFString) == .success else { return false }
  axSetSelection(el, pid: pid, text: next, NSRange(location: target.location + (text as NSString).length, length: 0))
  return true
}

/// An editing key on a focused web field. False when the key has no accessibility equivalent.
func axWebKey(_ field: AXUIElement, pid: pid_t, key: String, modifiers: [String]) -> Bool {
  guard let value = axFieldText(field) else { return false }
  let text = value as NSString
  let sel = axSelection(field, pid: pid, text: value)
  switch (key, Set(modifiers)) {
  case ("a", ["cmd"]):
    axSetSelection(field, pid: pid, text: value, NSRange(location: 0, length: text.length))
    return true
  case ("backspace", []):
    if sel.length > 0 { return axReplace(field, pid: pid, sel, with: "") }
    guard sel.location > 0 else { return true }
    return axReplace(field, pid: pid, text.rangeOfComposedCharacterSequence(at: sel.location - 1), with: "")
  case ("delete", []):
    if sel.length > 0 { return axReplace(field, pid: pid, sel, with: "") }
    guard sel.location < text.length else { return true }
    return axReplace(field, pid: pid, text.rangeOfComposedCharacterSequence(at: sel.location), with: "")
  default:
    return false
  }
}

func axSize(_ el: AXUIElement) -> CGSize? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &ref) == .success, let ref else { return nil }
  var size = CGSize.zero
  guard let value = asAXValue(ref) else { return nil }
  return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func axNumber(_ el: AXUIElement, _ attr: String) -> Double? {
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success else { return nil }
  return (ref as? NSNumber)?.doubleValue
}

/// Background scroll through accessibility: move the scroll bars of the scroll area under the point. Posted wheel
/// events don't reach background windows (AppKit routes them by the real pointer), scroll bar values do.
/// `dx`/`dy` are pixels (positive = right/down). Returns true when a scroll area moved.
func axScroll(pid: pid_t, at point: CGPoint, dx: Double, dy: Double) -> Bool {
  guard AXIsProcessTrusted() else { return false }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  var hit: AXUIElement?
  guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, var el = hit else { return false }
  for _ in 0..<12 {
    if axString(el, kAXRoleAttribute) == "AXScrollArea", let visible = axSize(el) {
      var contents: CFTypeRef?
      var doc: CGSize? = nil
      if AXUIElementCopyAttributeValue(el, kAXContentsAttribute as CFString, &contents) == .success, let list = contents as? [AXUIElement], let first = list.first {
        doc = axSize(first)
      }
      var moved = false
      for (delta, attr, docLen, visLen) in [(dy, kAXVerticalScrollBarAttribute, doc?.height, visible.height), (dx, kAXHorizontalScrollBarAttribute, doc?.width, visible.width)] {
        guard delta != 0 else { continue }
        var barRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &barRef) == .success, let bar = asElement(barRef) else { continue }
        guard let current = axNumber(bar, kAXValueAttribute) else { continue }
        // Fraction per pixel = 1 / scrollable length; without a document size assume one screen per 10% step.
        let scrollable = max(1, (docLen ?? visLen * 10) - visLen)
        let next = min(1, max(0, current + delta / scrollable))
        if abs(next - current) < 0.0001 { continue }
        if AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success { moved = true }
      }
      if moved { return true }
    }
    guard let parent = axParent(el) else { return false }
    el = parent
  }
  return false
}

func requireAccessibility() throws {
  guard AXIsProcessTrusted() else {
    throw HelperError("Accessibility permission is missing. Allow Godmode in System Settings → Privacy & Security → Accessibility.", code: "permission_accessibility")
  }
}

func pointer(_ p: Params) throws -> [String: Any] {
  try requireAccessibility()
  let pid = p.int("pid").map { pid_t($0) }
  let window = p.int("window")
  let action = p.string("action") ?? "click"
  let point = CGPoint(x: try p.requireDouble("x"), y: try p.requireDouble("y"))
  let (button, downType, upType, dragType) = mouseButton(p.string("button"))
  let flags = modifierFlags(p.strings("modifiers"))
  var method = "event"
  var frontStolen = false
  // One window of a background app: Cua Driver's routed recipes, window-local locations, the agent cursor.
  var routed: (pid: pid_t, window: Int, origin: CGPoint)? = nil
  if let pid, let window {
    guard let origin = windowOrigin(window) else { throw HelperError("The window is gone (closed or minimized).", code: "window_gone") }
    routed = (pid, window, origin)
  }
  let showCursor = routed != nil && (p.bool("cursor") ?? false)
  if let r = routed, showCursor { agentCursor(window: r.window, to: point) }
  func local(_ q: CGPoint) -> CGPoint {
    guard let r = routed else { return q }
    return CGPoint(x: q.x - r.origin.x, y: q.y - r.origin.y)
  }

  switch action {
  case "move":
    if let r = routed {
      if let e = routedEvent(.mouseMoved, at: point, button: .left, pid: r.pid, window: r.window, gesture: gestureId(), clickState: 0, subtype: 3, windowLocation: local(point), flags: flags) {
        SkyLight.postBoth(e, pid: r.pid)
      }
    } else {
      mouseEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window, flags: flags)
    }
  case "down":
    mouseEvent(downType, at: point, button: button, pid: pid, window: window, flags: flags)
  case "up":
    mouseEvent(upType, at: point, button: button, pid: pid, window: window, flags: flags)
  case "click":
    let count = max(1, min(3, p.int("count") ?? 1))
    if showCursor { agentCursorPulse() }
    if let r = routed {
      if button == .left && count == 1 && flags.isEmpty && axPress(pid: r.pid, at: point) {
        method = "ax"
      } else if button == .left && count == 1 && flags.isEmpty, let how = axWebClick(pid: r.pid, window: r.window, at: point) {
        method = how
      } else if button == .left {
        if !backgroundLeftClick(pid: r.pid, window: r.window, at: point, count: count, flags: flags) { frontStolen = true }
      } else {
        routedClick(pid: r.pid, window: r.window, at: point, local: local(point), button: button, downType: downType, upType: upType, count: count, flags: flags)
      }
      break
    }
    if let pid {
      mouseEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window)
      usleep(15_000)
      if button == .left && count == 1 && flags.isEmpty && axPress(pid: pid, at: point) {
        method = "ax"
        break
      }
    } else {
      mouseEvent(.mouseMoved, at: point, button: .left, pid: nil, window: nil)
      usleep(25_000)
    }
    for i in 1...count {
      mouseEvent(downType, at: point, button: button, pid: pid, window: window, clickState: i, flags: flags)
      usleep(18_000)
      mouseEvent(upType, at: point, button: button, pid: pid, window: window, clickState: i, flags: flags)
      if i < count { usleep(60_000) }
    }
  case "drag":
    let to = CGPoint(x: try p.requireDouble("toX"), y: try p.requireDouble("toY"))
    let steps = 12
    if let r = routed {
      let gesture = gestureId()
      func send(_ type: CGEventType, _ at: CGPoint, clickState: Int64, subtype: Int64, withButton: CGMouseButton) {
        guard let e = routedEvent(type, at: at, button: withButton, pid: r.pid, window: r.window, gesture: gesture, clickState: clickState, subtype: subtype, windowLocation: local(at), flags: flags) else { return }
        SkyLight.postBoth(e, pid: r.pid)
      }
      send(.mouseMoved, point, clickState: 0, subtype: 3, withButton: .left)
      usleep(12_000)
      send(downType, point, clickState: 1, subtype: 0, withButton: button)
      usleep(16_000)
      if showCursor { DispatchQueue.main.async { _ = AgentCursor.shared.move(window: r.window, to: to) } }
      for i in 1...steps {
        let t = Double(i) / Double(steps)
        send(dragType, CGPoint(x: point.x + (to.x - point.x) * t, y: point.y + (to.y - point.y) * t), clickState: 1, subtype: 0, withButton: button)
        usleep(16_000)
      }
      // Chromium handles the last move before the release ends its pointer capture.
      usleep(50_000)
      send(upType, to, clickState: 1, subtype: 0, withButton: button)
      usleep(100_000)
      break
    }
    mouseEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window)
    usleep(20_000)
    mouseEvent(downType, at: point, button: button, pid: pid, window: window, flags: flags)
    for i in 1...steps {
      let t = Double(i) / Double(steps)
      let q = CGPoint(x: point.x + (to.x - point.x) * t, y: point.y + (to.y - point.y) * t)
      usleep(16_000)
      mouseEvent(dragType, at: q, button: button, pid: pid, window: window, flags: flags)
    }
    usleep(30_000)
    mouseEvent(upType, at: to, button: button, pid: pid, window: window, flags: flags)
  case "scroll":
    let dx = Int32(max(-10_000, min(10_000, p.double("dx") ?? 0)))
    let dy = Int32(max(-10_000, min(10_000, p.double("dy") ?? 0)))
    if let pid, axScroll(pid: pid, at: point, dx: Double(dx), dy: Double(dy)) {
      method = "ax"
      break
    }
    if let r = routed {
      if let e = routedEvent(.mouseMoved, at: point, button: .left, pid: r.pid, window: r.window, gesture: gestureId(), clickState: 0, subtype: 3, windowLocation: local(point)) {
        SkyLight.postBoth(e, pid: r.pid)
      }
      usleep(12_000)
    } else if pid == nil {
      mouseEvent(.mouseMoved, at: point, button: .left, pid: nil, window: nil)
      usleep(20_000)
    }
    let source = CGEventSource(stateID: pid == nil || routed != nil ? .hidSystemState : .privateState)
    // Positive dy scrolls content down (like the wheel toward the user); CG uses the opposite sign.
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else {
      throw HelperError("Could not create the scroll event")
    }
    e.location = point
    if let r = routed {
      // Chromium hit-tests the wheel at the stamped point: the element under it scrolls, focused or not.
      SkyLight.setWindowLocation(e, local(point))
      SkyLight.set(e, 40, Int64(r.pid))
      SkyLight.set(e, 51, Int64(r.window))
      SkyLight.set(e, 91, Int64(r.window))
      SkyLight.set(e, 92, Int64(r.window))
      SkyLight.postBoth(e, pid: r.pid)
      usleep(30_000)
      break
    }
    if let window {
      e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
      e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    }
    post(e, pid: pid)
  default:
    throw HelperError("Unknown pointer action \"\(action)\"", code: "bad_request")
  }
  return ["method": method, "chromium": routed.map { isChromiumApp($0.pid) } ?? false, "cameToFront": frontStolen]
}

func cursor() -> [String: Any] {
  let loc = CGEvent(source: nil)?.location ?? .zero
  return ["x": Double(loc.x), "y": Double(loc.y)]
}

// MARK: - Apps & windows (desktop mode)

func activate(_ p: Params) throws -> [String: Any] {
  let pid = pid_t(try p.requireInt("pid"))
  guard let app = NSRunningApplication(processIdentifier: pid) else { throw HelperError("The app is not running.", code: "not_found") }
  var ok = false
  // Only the app (and then the one window) — not every window of it.
  DispatchQueue.main.sync { ok = app.activate(options: []) }
  if let window = p.int("window") { _ = raiseWindow(pid: pid, windowId: window) }
  return ["activated": ok]
}

/// CGWindowID of an AX window (private but long-standing ApplicationServices call).
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// The AX window of `pid` that is CG window `windowId`: by its exact window id, else by a unique frame match.
func axWindow(pid: pid_t, windowId: Int) -> AXUIElement? {
  guard AXIsProcessTrusted() else { return nil }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let list = value as? [AnyObject] else { return nil }
  let windows = list.compactMap { asElement($0) }
  for win in windows {
    var id: CGWindowID = 0
    if _AXUIElementGetWindow(win, &id) == .success, Int(id) == windowId { return win }
  }
  guard let info = windowById(windowId),
        let x = info["x"] as? Double, let y = info["y"] as? Double, let w = info["width"] as? Double, let h = info["height"] as? Double
  else { return nil }
  var matches: [AXUIElement] = []
  for win in windows {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    var pos = CGPoint(x: -99_999, y: -99_999)
    var size = CGSize.zero
    if AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posRef) == .success, let v = asAXValue(posRef) { AXValueGetValue(v, .cgPoint, &pos) }
    if AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sizeRef) == .success, let v = asAXValue(sizeRef) { AXValueGetValue(v, .cgSize, &size) }
    if abs(pos.x - x) < 2 && abs(pos.y - y) < 2 && abs(size.width - w) < 2 && abs(size.height - h) < 2 { matches.append(win) }
  }
  // Two windows with the same frame (e.g. both maximized) can't be told apart — better none than the wrong one.
  return matches.count == 1 ? matches[0] : nil
}

@discardableResult
func raiseWindow(pid: pid_t, windowId: Int) -> Bool {
  guard let win = axWindow(pid: pid, windowId: windowId) else { return false }
  return AXUIElementPerformAction(win, kAXRaiseAction as CFString) == .success
}

/// Keyboard events posted to a process go to its key window. Make the shared window the app's key window first —
/// but only while the human isn't using that app (raising a window of the frontmost app would pull their typing into
/// it). Returns "unknown" when the window can't be resolved through accessibility (e.g. on another Space), so another
/// route (Cua Driver) may still try.
func ensureKeyWindow(_ p: Params) throws -> [String: Any] {
  try requireAccessibility()
  let pid = pid_t(try p.requireInt("pid"))
  let windowId = try p.requireInt("window")
  guard let target = axWindow(pid: pid, windowId: windowId) else { return ["state": "unknown"] }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.5)
  func focused() -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &v) == .success else { return nil }
    return asElement(v)
  }
  if let f = focused(), CFEqual(f, target) { return ["state": "key"] }
  var frontmost = false
  DispatchQueue.main.sync { frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
  if frontmost {
    throw HelperError("You're using another window of this app right now, so typing could land there instead of the shared window.", code: "not_key_window")
  }
  AXUIElementPerformAction(target, kAXRaiseAction as CFString)
  AXUIElementSetAttributeValue(target, kAXMainAttribute as CFString, kCFBooleanTrue)
  usleep(80_000)
  if let f = focused(), CFEqual(f, target) { return ["state": "raised"] }
  throw HelperError("Another window of this app has the keyboard focus, so typing could land there instead of the shared window.", code: "not_key_window")
}

func openApp(_ p: Params) throws -> [String: Any] {
  let name = p.string("name")?.trimmingCharacters(in: .whitespaces) ?? ""
  var url: URL? = nil
  if let bundleId = p.string("bundleId") { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }
  if url == nil, !name.isEmpty {
    let fm = FileManager.default
    let candidates = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", NSHomeDirectory() + "/Applications"]
    for dir in candidates {
      let path = "\(dir)/\(name.hasSuffix(".app") ? name : name + ".app")"
      if fm.fileExists(atPath: path) { url = URL(fileURLWithPath: path); break }
    }
    if url == nil, let match = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) {
      url = match.bundleURL
    }
  }
  guard let appURL = url else { throw HelperError("No app named \"\(name)\" was found.", code: "not_found") }
  let config = NSWorkspace.OpenConfiguration()
  config.activates = p.bool("activate") ?? true
  let sem = DispatchSemaphore(value: 0)
  var pid: Int? = nil
  var failure: Error? = nil
  NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, err in
    pid = app.map { Int($0.processIdentifier) }
    failure = err
    sem.signal()
  }
  if sem.wait(timeout: .now() + 20) == .timedOut { throw HelperError("Timed out opening the app") }
  if let failure { throw HelperError("Could not open the app: \(failure.localizedDescription)") }
  return ["pid": pid ?? NSNull(), "path": appURL.path]
}

// MARK: - Focus guard (agent browsers)

/// Chromium activates itself when a page opens a tab or popup, or when a tool opens a tab in the foreground — taking
/// the keyboard from whatever the human is doing. While the core has armed an agent browser (it just opened a tab),
/// an activation the human didn't make by clicking one of its windows is handed straight back. Main thread only.
final class FocusGuard {
  static let shared = FocusGuard()
  private var armedUntil: [pid_t: Date] = [:]
  private var current: NSRunningApplication?
  private var lastTaken: (pid: pid_t, at: Date, from: NSRunningApplication?, byHuman: Bool)?
  private var observing = false

  func arm(pid: pid_t, ms: Int) {
    observe()
    let now = Date()
    armedUntil[pid] = max(armedUntil[pid] ?? now, now.addingTimeInterval(Double(ms) / 1000))
    // The tab's activation can come before the core heard of the tab.
    if ms > 0, let t = lastTaken, t.pid == pid, !t.byHuman, now.timeIntervalSince(t.at) < 1.5,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
      giveBack(to: t.from)
    }
  }

  private func observe() {
    if observing { return }
    observing = true
    current = NSWorkspace.shared.frontmostApplication
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      self?.activated(app)
    }
  }

  private func activated(_ app: NSRunningApplication) {
    let before = current
    current = app
    let pid = app.processIdentifier
    guard before?.processIdentifier != pid, let until = armedUntil[pid] else { return }
    let byHuman = clickedInto(pid)
    lastTaken = (pid, Date(), before, byHuman)
    if !byHuman, until > Date() { giveBack(to: before) }
  }

  private func giveBack(to app: NSRunningApplication?) {
    lastTaken = nil
    guard let app, !app.isTerminated, app.processIdentifier != getpid() else { return }
    app.activate(options: [])
  }

  /// Did the human just click one of the app's windows?
  private func clickedInto(_ pid: pid_t) -> Bool {
    let since = min(
      CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .leftMouseDown),
      CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .rightMouseDown))
    guard since < 1 else { return false }
    let point = CGEvent(source: nil)?.location ?? .zero
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
      guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner != Int(getpid()),
            (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
            let bounds = w[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds), rect.contains(point)
      else { continue }
      return owner == Int(pid)
    }
    return false
  }
}

// MARK: - Dispatch

/// Input runs one command at a time (event order matters); lookups run concurrently so a long `type` doesn't block them.
let inputQueue = DispatchQueue(label: "godmode.computer.input")
let readQueue = DispatchQueue(label: "godmode.computer.read", attributes: .concurrent)
let readCommands: Set<String> = ["hello", "permissions", "displays", "windows", "window", "apps", "cursor", "guardFocus"]

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return }
  let id = obj["id"] ?? NSNull()
  let cmd = obj["cmd"] as? String ?? ""
  let p = Params(raw: obj)

  func reply(_ body: () throws -> Any) {
    do {
      emit(["id": id, "ok": true, "result": try body()])
    } catch let e as HelperError {
      emit(["id": id, "ok": false, "error": e.message, "code": e.code])
    } catch {
      emit(["id": id, "ok": false, "error": "\(error)", "code": "failed"])
    }
  }

  if cmd == "capture" {
    Task {
      do {
        emit(["id": id, "ok": true, "result": try await capture(p)])
      } catch let e as HelperError {
        emit(["id": id, "ok": false, "error": e.message, "code": e.code])
      } catch {
        let message = "\(error.localizedDescription)"
        let denied = message.localizedCaseInsensitiveContains("declined") || message.localizedCaseInsensitiveContains("permission")
        emit(["id": id, "ok": false, "error": denied ? "Screen Recording permission is missing. Allow Godmode in System Settings → Privacy & Security → Screen & System Audio Recording." : message, "code": denied ? "permission_screen" : "failed"])
      }
    }
    return
  }

  (readCommands.contains(cmd) ? readQueue : inputQueue).async {
    reply {
      switch cmd {
      case "hello":
        return ["version": HELPER_VERSION, "os": ProcessInfo.processInfo.operatingSystemVersionString, "pid": Int(ProcessInfo.processInfo.processIdentifier)]
      case "permissions": return permissions()
      case "requestPermissions": return requestPermissions(p)
      case "displays": return displays()
      case "windows": return windows(p)
      case "window": return windowById(try p.requireInt("window")) ?? NSNull()
      case "apps": return apps()
      case "cursor": return cursor()
      case "pointer": return try pointer(p)
      case "key":
        try requireAccessibility()
        return try pressKey(p)
      case "type":
        try requireAccessibility()
        return try typeText(p)
      case "activate": return try activate(p)
      case "ensureKeyWindow": return try ensureKeyWindow(p)
      case "openApp": return try openApp(p)
      case "guardFocus":
        let pid = pid_t(try p.requireInt("pid"))
        let ms = max(0, min(p.int("ms") ?? 0, 10_000))
        DispatchQueue.main.async { FocusGuard.shared.arm(pid: pid, ms: ms) }
        return ["ok": true]
      case "agentCursor":
        if p.bool("hide") == true {
          let window = p.int("window")
          DispatchQueue.main.async { AgentCursor.shared.hide(window: window) }
          return ["ok": true]
        }
        agentCursor(window: try p.requireInt("window"), to: CGPoint(x: try p.requireDouble("x"), y: try p.requireDouble("y")))
        if p.bool("click") == true { agentCursorPulse() }
        return ["ok": true]
      default: throw HelperError("Unknown command \"\(cmd)\"", code: "bad_request")
      }
    }
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)
emit(["ready": true, "version": HELPER_VERSION])

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    handle(line)
  }
  // stdin closed: the core went away.
  exit(0)
}

// The main thread runs AppKit: it keeps its state fresh (frontmost app, running apps), runs main-thread work (TIS,
// activation) and draws the agent cursor. An accessory app: no Dock icon, never activated.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.run()
