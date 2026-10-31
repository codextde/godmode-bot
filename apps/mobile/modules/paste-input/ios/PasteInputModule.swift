import ExpoModulesCore
import ObjectiveC
import UIKit
import UniformTypeIdentifiers

public class PasteInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PasteInput")

    Events("onPaste")

    OnCreate { [weak self] in
      PasteHook.onFiles = { files in
        self?.sendEvent("onPaste", ["files": files])
      }
      DispatchQueue.main.async { PasteHook.install() }
    }

    Function("setActive") { (active: Bool) in
      DispatchQueue.main.async { PasteHook.active = active }
    }
  }
}

enum PasteHook {
  static var active = false
  static var onFiles: (([[String: Any]]) -> Void)?
  private static var installed = false

  private typealias CanPerform = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
  private typealias Paste = @convention(c) (AnyObject, Selector, Any?) -> Void

  static func install() {
    guard !installed, let cls = NSClassFromString("RCTUITextView") else { return }
    installed = true

    let canSel = #selector(UIResponder.canPerformAction(_:withSender:))
    let pasteSel = #selector(UIResponderStandardEditActions.paste(_:))

    if let method = class_getInstanceMethod(cls, canSel) {
      let original = unsafeBitCast(method_getImplementation(method), to: CanPerform.self)
      let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { view, action, sender in
        if original(view, canSel, action, sender) { return true }
        return active && action == pasteSel && hasFiles(UIPasteboard.general)
      }
      method_setImplementation(method, imp_implementationWithBlock(block))
    }

    if let method = class_getInstanceMethod(cls, pasteSel) {
      let original = unsafeBitCast(method_getImplementation(method), to: Paste.self)
      let block: @convention(block) (AnyObject, Any?) -> Void = { view, sender in
        let board = UIPasteboard.general
        guard active, hasFiles(board) else {
          original(view, pasteSel, sender)
          return
        }
        let withText = board.hasStrings && !board.hasURLs
        collect(board.itemProviders) { files in
          if !files.isEmpty { onFiles?(files) }
        }
        if withText { original(view, pasteSel, sender) }
      }
      method_setImplementation(method, imp_implementationWithBlock(block))
    }
  }

  private static let fileTypes: [UTType] = [
    .image, .audiovisualContent, .pdf, .archive, .spreadsheet, .presentation,
    UTType("org.openxmlformats.wordprocessingml.document"), UTType("com.microsoft.word.doc"),
  ].compactMap { $0 }

  private static func fileType(_ identifiers: [String]) -> UTType? {
    for id in identifiers {
      guard let type = UTType(id) else { continue }
      if fileTypes.contains(where: { type.conforms(to: $0) }) { return type }
    }
    return nil
  }

  static func hasFiles(_ board: UIPasteboard) -> Bool {
    if board.hasImages { return true }
    return fileType(board.types) != nil
  }

  private static let keptImages: Set<UTType> = [.png, .jpeg, .gif, .webP]

  private static func collect(_ providers: [NSItemProvider], done: @escaping ([[String: Any]]) -> Void) {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("pasted", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    var results = [[String: Any]?](repeating: nil, count: providers.count)
    let group = DispatchGroup()
    let lock = NSLock()

    for (index, provider) in providers.enumerated() {
      guard let type = fileType(provider.registeredTypeIdentifiers) else { continue }
      group.enter()
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        defer { group.leave() }
        guard let url else { return }
        lock.lock()
        results[index] = store(url, type: type, suggested: provider.suggestedName, index: index, in: dir)
        lock.unlock()
      }
    }

    group.notify(queue: .main) { done(results.compactMap { $0 }) }
  }

  private static func store(_ source: URL, type: UTType, suggested: String?, index: Int, in dir: URL) -> [String: Any]? {
    let isImage = type.conforms(to: .image)
    let convert = isImage && !keptImages.contains(where: { type.conforms(to: $0) })
    let outType: UTType = convert ? .jpeg : type
    let ext = outType.preferredFilenameExtension ?? source.pathExtension
    let stem = baseName(suggested) ?? baseName(source.lastPathComponent) ?? (isImage ? "pasted-image-\(index + 1)" : "pasted-file-\(index + 1)")
    var name = ext.isEmpty ? stem : "\(stem).\(ext)"
    if FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) {
      name = ext.isEmpty ? "\(stem)-\(index + 1)" : "\(stem)-\(index + 1).\(ext)"
    }
    let dest = dir.appendingPathComponent(name)

    do {
      if convert {
        guard let image = UIImage(contentsOfFile: source.path), let data = image.jpegData(compressionQuality: 0.85) else { return nil }
        try data.write(to: dest)
      } else {
        try FileManager.default.copyItem(at: source, to: dest)
      }
    } catch {
      return nil
    }

    let size = (try? dest.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    return [
      "uri": dest.absoluteString,
      "name": name,
      "mime": outType.preferredMIMEType ?? "application/octet-stream",
      "size": size,
    ]
  }

  private static func baseName(_ name: String?) -> String? {
    guard let name, !name.isEmpty else { return nil }
    let stem = (name as NSString).deletingPathExtension
    if stem.isEmpty || stem.hasPrefix(".") || UUID(uuidString: stem) != nil { return nil }
    return stem.replacingOccurrences(of: "/", with: "-")
  }
}
