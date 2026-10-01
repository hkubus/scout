# Scout for iOS

A native SwiftUI client for a self-hosted Scout server. It covers:

- the top deals (Strong or better, untriaged first);
- live marketplace search, like the web Search page, with "Save as watch";
- the paginated listing history with triage (buy / maybe / pass / hide);
- listing detail with price history and the AI description check;
- creating, editing, archiving, pausing, and scanning watches, plus asking-price analytics;
- market research watches with probable-sale estimates, saved listings, and saved copies;
- deal analytics (Market tab → Analytics);
- connector health, and a switch that makes ntfy alerts open in the app;
- Home Screen and Lock Screen widgets.

Live updates come from the server's `/events` stream. Notifications stay with ntfy.

The app talks to the same API as the web UI. If the server has sign-in enabled, enter one of its `SCOUT_API_TOKENS` on the connect screen; the app sends it as a bearer token and keeps it in the Keychain under the App Group, so the widgets can use it too (widgets only send it to the server the app is connected to). Replace or remove it later in Settings → API token. Configure `SCOUT_API_TOKENS` whenever Scout is reached through a proxy or tunnel, including Tailscale Serve/Funnel and Cloudflare Tunnel: without credentials Scout refuses proxied requests. Only a direct LAN connection to Scout's own address (with `SCOUT_AUTH=off` when it listens beyond loopback) works without sign-in.

## Layout

| Path | Contents |
| --- | --- |
| `project.yml` | XcodeGen spec; `Scout.xcodeproj` and `Scout/Info.plist` are generated and not committed. |
| `Scout/` | SwiftUI app (iOS 17+). |
| `ScoutWidgets/` | WidgetKit extension: "Top deals" (small, medium, large) and "Scout summary" (small plus Lock Screen). |
| `Shared/` | Widget views, compiled into both the extension and the app's widget preview screen. |
| `ScoutKit/` | Swift package with the API models, HTTP client, server-sent-event parser, and demo fixtures. It builds and tests on Linux. |
| `scripts/screenshots.sh` | CI helper that captures simulator screenshots on demo data. |
| `scripts/sidestore_site.py` | Builds the GitHub Pages site with the IPA and the SideStore source. |

## Building without a Mac

`.github/workflows/ios.yml` runs on GitHub's macOS runners. The Forgejo repository push-mirrors to `github.com/hkubus/scout`, and every push to `main` that touches `ios/` does the following:

1. Runs the ScoutKit tests.
2. Generates the Xcode project and builds an **unsigned** IPA.
3. Captures simulator screenshots of each screen on demo data (light and dark).
4. Uploads the IPA and screenshots as a workflow artifact.
5. Publishes <https://hkubus.github.io/scout/>, which holds the IPA, `source.json`, and the screenshots.

The version is `0.1.<commit count>`, so every build is an update as far as SideStore is concerned.

To check the Swift package locally on Linux, install a Swift toolchain from swift.org and run:

```bash
cd ios/ScoutKit
swift test
```

The SwiftUI views only compile on macOS, so the first place view errors show up is the CI run.

## Installing with SideStore

1. Set up SideStore on the iPhone with your Apple ID (<https://sidestore.io>).
2. In SideStore, go to **Sources → +** and add `https://hkubus.github.io/scout/source.json`. You can also open the Pages site on the phone and tap "Add source to SideStore".
3. Install Scout from the source. Later builds show up as updates.
4. Open Scout and enter your server address, for example `http://192.168.1.10:3001` or `https://scout.your-tailnet.ts.net`. Addresses without a scheme default to `https://`. **Explore with demo data** works without a server.

Free Apple ID limits: apps must be refreshed every 7 days, and SideStore's refresh VPN can't run at the same time as another VPN such as Tailscale. Refresh while Tailscale is off, or while you're on your home LAN.

## Widgets

To add a widget, long-press the Home Screen, tap **Edit → Add Widget**, and search for Scout. The widgets fetch `/api/dashboard` about every 15 minutes, and the app refreshes them whenever it loads new data. They show the last saved data, marked "Offline", when the server can't be reached, for example when the VPN is off.

The widgets find your server through an App Group they share with the app. CI signs the IPA ad hoc with that entitlement so SideStore registers the group. SideStore renames the group for your Apple ID, and ScoutKit's `SharedStore` finds the renamed ID through the `ALTAppGroups` key that SideStore writes into Info.plist. If the group isn't available anyway (the Settings footer says so), long-press the widget, choose **Edit Widget**, and enter the server address there.

In demo mode, **Settings → Preview widgets** shows every widget size; the CI screenshots use it.

## Deep links

`scout://listing?key=<marketplace>:<listing id>&watchId=<watch id>` opens a listing, and `scout://deals` opens the Deals tab. The widgets use both.

To make ntfy alerts open in the app, turn on **Open alerts in the Scout iOS app**: in the web app it's under Settings → ntfy notifications, and in the iOS app under Settings → Notifications. Tapping an alert then opens the listing in Scout, and the alert's **Open listing** action button still goes to the marketplace page. The setting applies to every device subscribed to the topic, so leave it off if you also read alerts on a computer or Android.
