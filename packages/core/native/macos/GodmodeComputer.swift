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

let HELPER_VERSION = "1"

// MARK: - Output

let outputLock = NSLock()

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  outputLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  outputLock.unlock()
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
    filter = SCContentFilter(display: d, excludingWindows: [])
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

func pressKey(_ p: Params) throws {
  let pid = p.int("pid").map { pid_t($0) }
  let name = (p.string("key") ?? "").lowercased()
  let action = p.string("action") ?? "press"
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
}

func typeText(_ p: Params) throws {
  let pid = p.int("pid").map { pid_t($0) }
  guard let text = p.string("text") else { throw HelperError("Missing \"text\"", code: "bad_request") }
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

  switch action {
  case "move":
    mouseEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window, flags: flags)
  case "down":
    mouseEvent(downType, at: point, button: button, pid: pid, window: window, flags: flags)
  case "up":
    mouseEvent(upType, at: point, button: button, pid: pid, window: window, flags: flags)
  case "click":
    let count = max(1, min(3, p.int("count") ?? 1))
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
    mouseEvent(.mouseMoved, at: point, button: .left, pid: pid, window: window)
    usleep(20_000)
    mouseEvent(downType, at: point, button: button, pid: pid, window: window, flags: flags)
    let steps = 12
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
    if pid == nil {
      mouseEvent(.mouseMoved, at: point, button: .left, pid: nil, window: nil)
      usleep(20_000)
    }
    let source = CGEventSource(stateID: pid == nil ? .hidSystemState : .privateState)
    // Positive dy scrolls content down (like the wheel toward the user); CG uses the opposite sign.
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else {
      throw HelperError("Could not create the scroll event")
    }
    e.location = point
    if let window {
      e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
      e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    }
    post(e, pid: pid)
  default:
    throw HelperError("Unknown pointer action \"\(action)\"", code: "bad_request")
  }
  return ["method": method]
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

// MARK: - Dispatch

/// Input runs one command at a time (event order matters); lookups run concurrently so a long `type` doesn't block them.
let inputQueue = DispatchQueue(label: "godmode.computer.input")
let readQueue = DispatchQueue(label: "godmode.computer.read", attributes: .concurrent)
let readCommands: Set<String> = ["hello", "permissions", "displays", "windows", "window", "apps", "cursor"]

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
        try pressKey(p)
        return ["ok": true]
      case "type":
        try requireAccessibility()
        try typeText(p)
        return ["ok": true]
      case "activate": return try activate(p)
      case "ensureKeyWindow": return try ensureKeyWindow(p)
      case "openApp": return try openApp(p)
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

// The main run loop keeps AppKit state fresh (frontmost app, running apps) and runs main-thread work (TIS, activation).
RunLoop.main.run()
