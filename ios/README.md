# Scout for iOS

A native SwiftUI client for a self-hosted Scout server. It covers the deal feed, the paginated listing history with triage (buy / watch / pass / hide), listing detail with price history and the AI description check, watches with asking-price analytics, pause/resume and scan-now, and connector health. Live updates come from the server's `/events` stream. Notifications stay with ntfy.

Like the web UI, the app talks to the unauthenticated API, so the phone must reach Scout over your LAN or VPN (for example Tailscale).

## Layout

| Path | Contents |
| --- | --- |
| `project.yml` | XcodeGen spec; `Scout.xcodeproj` and `Scout/Info.plist` are generated and not committed. |
| `Scout/` | SwiftUI app (iOS 17+). |
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

## Deep links

`scout://listing?key=<marketplace>:<listing id>&watchId=<watch id>` opens a listing. A future server change can point ntfy's click action at this link so notifications open in the app.
