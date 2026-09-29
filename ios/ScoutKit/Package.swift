// swift-tools-version:5.10
import PackageDescription

// Platform-neutral core for the iOS app: API models, the HTTP client, the
// server-sent-event parser, and demo fixtures. It builds and tests on Linux so
// most logic can be checked without a Mac; only the SwiftUI app needs Xcode.
let package = Package(
    name: "ScoutKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ScoutKit", targets: ["ScoutKit"]),
    ],
    targets: [
        .target(
            name: "ScoutKit",
            resources: [.copy("Demo")]
        ),
        .testTarget(name: "ScoutKitTests", dependencies: ["ScoutKit"]),
    ]
)
