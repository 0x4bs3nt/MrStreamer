import ExpoModulesCore

/**
 The JavaScript face of `TransferOwner`, for `src/download-task.ts`. Events are hints; the
 ledger, read by `reconcile`, is what counts.
 */
public class BackgroundDownloadsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackgroundDownloads")

    Events("progress", "receipt")

    OnCreate {
      TransferOwner.shared.listen { [weak self] name, body in self?.sendEvent(name, body) }
    }

    OnDestroy {
      TransferOwner.shared.listen(nil)
    }

    AsyncFunction("reconcile") { (promise: Promise) in
      TransferOwner.shared.reconcile { answer(promise, $0) }
    }

    AsyncFunction("start") { (request: StartRequest, promise: Promise) in
      TransferOwner.shared.start(
        id: request.id, attempt: request.attempt, ext: request.ext, url: request.url,
        headers: request.headers
      ) { answer(promise, $0) }
    }

    AsyncFunction("pause") { (attempt: String, promise: Promise) in
      TransferOwner.shared.pause(attempt: attempt) { promise.resolve(nil) }
    }

    AsyncFunction("cancel") { (attempt: String, promise: Promise) in
      TransferOwner.shared.cancel(attempt: attempt) { promise.resolve(nil) }
    }

    AsyncFunction("acknowledge") { (receipts: [String], promise: Promise) in
      TransferOwner.shared.acknowledge(receipts) { answer(promise, $0) }
    }

    AsyncFunction("forgetResume") { (id: String, promise: Promise) in
      TransferOwner.shared.forgetResume(id: id) { answer(promise, $0) }
    }

    AsyncFunction("importResume") { (id: String, url: String, data: String, promise: Promise) in
      TransferOwner.shared.importResume(id: id, url: url, data: data) { answer(promise, $0) }
    }
  }
}

struct StartRequest: Record {
  @Field var id: String = ""
  @Field var attempt: String = ""
  @Field var ext: String = ""
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
}

private func answer<Value>(_ promise: Promise, _ result: Result<Value, Refusal>) {
  switch result {
  case .success(let value): promise.resolve(value)
  case .failure(let refusal): promise.reject(refusal.rawValue, refusal.words)
  }
}

private func answer(_ promise: Promise, _ result: Result<Void, Refusal>) {
  switch result {
  case .success: promise.resolve(nil)
  case .failure(let refusal): promise.reject(refusal.rawValue, refusal.words)
  }
}

/**
 Makes the session as the app launches, before JavaScript, and takes iOS's wakes for it. A wake
 for any other session is answered at once: Expo calls the system's handler only once every
 subscriber answered.
 */
public class BackgroundDownloadsLaunch: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TransferOwner.shared.connect()
    return true
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if identifier == TransferOwner.identifier {
      TransferOwner.shared.hold(completionHandler)
    } else {
      completionHandler()
    }
  }
}
