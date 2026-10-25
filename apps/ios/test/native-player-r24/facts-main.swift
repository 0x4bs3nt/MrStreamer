import AVFoundation
import Foundation

@main
struct FactsContract {
  static func main() throws {
    let canary = "mr-r24-secret-canary"
    var nested = NSError(domain: canary, code: 429,
      userInfo: [NSLocalizedDescriptionKey: canary, NSURLErrorFailingURLErrorKey: URL(string: "https://example.invalid/\(canary)")!])
    for code in 0..<8 {
      nested = NSError(domain: canary, code: code, userInfo: [NSUnderlyingErrorKey: nested])
    }
    let unknown = ObservedFailure.system(nested, origin: "asset")
    let bytes = try JSONSerialization.data(withJSONObject: unknown, options: [.sortedKeys])
    precondition(!String(decoding: bytes, as: UTF8.self).contains(canary))
    let evidence = unknown["evidence"] as! [String: Any]
    precondition((evidence["underlying"] as! [[String: Any]]).count == 4)
    for code in [401, 403, 404, 410, 429, 500] {
      precondition(ObservedFailure.errorLog(domain: canary, code: code)["kind"] as? String == "unknown")
    }
    let cases: [(String, Int, String)] = [
      (NSURLErrorDomain, URLError.Code.timedOut.rawValue, "network"),
      (NSURLErrorDomain, URLError.Code.userAuthenticationRequired.rawValue, "auth"),
      (AVFoundationErrorDomain, AVError.Code.decodeFailed.rawValue, "decode"),
      (AVFoundationErrorDomain, AVError.Code.fileFormatNotRecognized.rawValue, "unsupported"),
      (canary, 401, "unknown")
    ]
    for (domain, code, kind) in cases {
      precondition(ObservedFailure.system(NSError(domain: domain, code: code), origin: "item")["kind"] as? String == kind)
    }
    let cancelled = ObservedAssetLoad()
    cancelled.cancel()
    do {
      try cancelled.register(AVURLAsset(url: URL(fileURLWithPath: "/dev/null")))
      preconditionFailure("Retired asset registration succeeded")
    } catch is CancellationError {}
    let active = ObservedAssetLoad()
    try active.register(AVURLAsset(url: URL(fileURLWithPath: "/dev/null")))
    active.cancel()
    do { try active.check(); preconditionFailure("Retired load continued") } catch is CancellationError {}
    print("Production native facts: safe evidence and asset retirement passed")
  }
}
