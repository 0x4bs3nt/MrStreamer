import ExpoModulesCore
import UIKit

/**
 The JavaScript face of `TransferOwner`, for `src/download-task.ts`. Events are hints; the queue,
 read by `reconcile`, is what counts.
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

    AsyncFunction("sourceState") { (source: String, promise: Promise) in
      TransferOwner.shared.sourceState(source) { answer(promise, $0) }
    }

    AsyncFunction("enableSource") { (command: SourceCommand, promise: Promise) in
      TransferOwner.shared.enableSource(
        command.sourceId, epoch: command.queueEpoch, expected: command.expected
      ) { answer(promise, $0) }
    }

    AsyncFunction("revokeSource") { (command: SourceCommand, promise: Promise) in
      TransferOwner.shared.revokeSource(
        command.sourceId, epoch: command.queueEpoch, expected: command.expected
      ) { answer(promise, $0) }
    }

    AsyncFunction("reserve") { (request: Reservation, promise: Promise) in
      TransferOwner.shared.reserve(
        id: request.id, ext: request.ext, source: request.sourceId,
        generation: request.sourceGeneration
      ) { answer(promise, $0) }
    }

    AsyncFunction("authorize") { (request: ArmRequest, promise: Promise) in
      TransferOwner.shared.authorize(
        request.authorization, url: request.url, headers: request.headers
      ) { answer(promise, $0) }
    }

    AsyncFunction("cancelAuthorization") { (authorization: String, reason: String, promise: Promise) in
      TransferOwner.shared.cancelAuthorization(authorization, reason: reason) { answer(promise, $0) }
    }

    AsyncFunction("drainDownload") { (id: String, promise: Promise) in
      TransferOwner.shared.drain(download: id) { answer(promise, $0) }
    }

    AsyncFunction("acquirePlayback") { (request: PlaybackHold, promise: Promise) in
      TransferOwner.shared.acquirePlayback(source: request.sourceId, lease: request.lease) {
        answer(promise, $0)
      }
    }

    AsyncFunction("releasePlayback") { (lease: String, promise: Promise) in
      TransferOwner.shared.releasePlayback(lease) { promise.resolve(nil) }
    }

    AsyncFunction("reconcile") { (context: String, promise: Promise) in
      TransferOwner.shared.reconcile(context: context) { answer(promise, $0) }
    }

    AsyncFunction("finishForegroundReconcile") { (token: String, promise: Promise) in
      TransferOwner.shared.finishForegroundReconcile(token) { answer(promise, $0) }
    }

    AsyncFunction("resetQueue") { (scope: ResetScope, promise: Promise) in
      TransferOwner.shared.resetQueue(epoch: scope.queueEpoch, knownSources: scope.knownSourceIds) {
        answer(promise, $0)
      }
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

struct SourceCommand: Record {
  @Field var sourceId: String = ""
  @Field var queueEpoch: String = ""
  @Field var expected: String = ""
}

struct Reservation: Record {
  @Field var id: String = ""
  @Field var ext: String = ""
  @Field var sourceId: String = ""
  @Field var sourceGeneration: String = ""
}

struct ArmRequest: Record {
  @Field var authorization: String = ""
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
}

struct PlaybackHold: Record {
  @Field var sourceId: String = ""
  @Field var lease: String = ""
}

struct ResetScope: Record {
  @Field var queueEpoch: String = ""
  @Field var knownSourceIds: [String] = []
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
 subscriber answered. The app's first activation in a process puts up the queue's foreground
 barrier, which JavaScript's first foreground reconcile then finishes.
 */
public class BackgroundDownloadsLaunch: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TransferOwner.shared.connect()
    let center = NotificationCenter.default
    center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
    ) { _ in TransferOwner.shared.didBecomeActive() }
    center.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: nil
    ) { _ in TransferOwner.shared.willResignActive() }
    if application.applicationState == .active { TransferOwner.shared.didBecomeActive() }
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
