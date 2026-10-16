import ExpoModulesCore

/**
 The first private betas let iOS's URL cache keep the provider's answers on disk, each under an
 address carrying the username and password, outside the Keychain and past Disconnect. Requests
 to the provider now ask it to keep nothing (`src/account.ts`); this drops what is already there,
 once, at the first launch of a build that has it, before any JavaScript asks the provider for
 anything. The cache holds nothing else the app needs: artwork is fetched again when shown.
 */
public class ForgetCachedLogins: ExpoAppDelegateSubscriber {
  private static let done = "forgotCachedLogins"

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let defaults = UserDefaults.standard
    if !defaults.bool(forKey: Self.done) {
      URLCache.shared.removeAllCachedResponses()
      defaults.set(true, forKey: Self.done)
    }
    return true
  }
}
