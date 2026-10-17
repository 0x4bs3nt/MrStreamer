import ExpoModulesCore

/// Plays files AVPlayer can't open by serving them as loopback HLS (`modules/title-formats`).
/// The JavaScript names each session, so it can close one that is still opening.
public class TitleFormatsModule: Module {
  private let lock = NSLock()
  private var sessions: [String: FormatSession] = [:]

  private func session(_ id: String) -> FormatSession? {
    lock.lock()
    defer { lock.unlock() }
    return sessions[id]
  }

  public func definition() -> ModuleDefinition {
    Name("TitleFormats")

    /// `{ id, failure }` when session `id`, once open, stops serving: the same failure
    /// `failure` answers from then on.
    Events("onFailure")

    /// Makes session `id` for `url`, a provider's file or a copy's `file:` address, to start at
    /// `start` seconds, without reading anything yet. Synchronous, so `close` and `closed` find it from here on.
    Function("create") { (id: String, url: String, headers: [String: String]?, start: Double) in
      let address = URL(string: url) ?? URL(fileURLWithPath: "/nonexistent")
      let made = FormatSession(url: address, headers: headers ?? [:], start: start) {
        [weak self] failure in
        self?.sendEvent("onFailure", ["id": id, "failure": failure.record])
      }
      self.lock.lock()
      self.sessions[id] = made
      self.lock.unlock()
      made.whenClosed { [weak self] in
        self?.lock.lock()
        if self?.sessions[id] === made { self?.sessions[id] = nil }
        self?.lock.unlock()
      }
    }

    /// Reads the file's header and index. Answers the playlist to give AVPlayer, `direct` for a
    /// file AVPlayer opens itself, or why it failed; the session is closing already unless it
    /// answered a playlist.
    AsyncFunction("open") { (id: String, promise: Promise) in
      guard let made = self.session(id) else { return promise.resolve(["kind": "closed"]) }
      made.open { opened in
        switch opened {
        case .session(let playlist):
          promise.resolve(["kind": "session", "playlist": playlist])
        case .direct:
          made.close()
          promise.resolve(["kind": "direct"])
        case .failed(let failure):
          made.close()
          promise.resolve(["kind": "failed", "failure": failure.record])
        case .closed:
          made.close()
          promise.resolve(["kind": "closed"])
        }
      }
    }

    /// Stops the session at once: AVPlayer's requests find nothing, and the provider's request
    /// is cancelled.
    Function("close") { (id: String) in
      self.session(id)?.close()
    }

    /// Resolves once the session's request to the provider ended and its memory is freed.
    AsyncFunction("closed") { (id: String, promise: Promise) in
      guard let made = self.session(id) else { return promise.resolve(nil) }
      made.whenClosed { promise.resolve(nil) }
    }

    /// The session's requests to the provider so far, without their address, for the native
    /// proof's record of timing; empty once it closed.
    Function("trace") { (id: String) -> [[String: Any]] in
      self.session(id)?.trace ?? []
    }

    /// Why the session stopped serving, if it did.
    Function("failure") { (id: String) -> [String: Any]? in
      self.session(id)?.failure?.record
    }
  }
}
