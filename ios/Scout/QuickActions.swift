import SwiftUI
import UIKit

/// Home Screen quick actions (long-press the app icon). Each item's type is
/// a `scout://` link that `AppModel.open` handles, the same as widget links.
@MainActor
@Observable
final class QuickActions {
    static let shared = QuickActions()
    /// The chosen action's link, until the app handles it.
    var pending: URL?

    fileprivate func perform(_ item: UIApplicationShortcutItem) {
        pending = URL(string: item.type)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        // A cold launch from a quick action delivers it here, not to the scene delegate.
        if let item = options.shortcutItem {
            MainActor.assumeIsolated { QuickActions.shared.perform(item) }
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = QuickActionSceneDelegate.self
        return configuration
    }
}

final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        MainActor.assumeIsolated { QuickActions.shared.perform(shortcutItem) }
        completionHandler(true)
    }
}
