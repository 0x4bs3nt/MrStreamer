import ExpoModulesCore

/**
 Downloaded movies and episodes live in Documents/downloads (`src/downloads.ts`), which iOS would
 back up to iCloud and to a computer with the rest of Documents. They can be downloaded again, so
 Apple's storage guidelines keep them out of backups. Each launch, before the app's JavaScript
 runs, this makes the folder if it isn't there and marks it excluded, which covers everything in
 it; the JavaScript only ever makes and deletes the folders inside. Unlike Caches, iOS doesn't
 delete it when storage runs low, so a copy stays until the viewer deletes it.
 */
public class DownloadsFolder: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    guard
      var folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
        .appendingPathComponent("downloads", isDirectory: true)
    else { return true }
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
    } catch {
      // Tried again at the next launch; the downloads work either way.
    }
    return true
  }
}
