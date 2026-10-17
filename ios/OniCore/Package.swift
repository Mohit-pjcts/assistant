// swift-tools-version: 6.0
//
// OniCore — the iPhone app's logic with no UI: the Vault sync engine, the
// Replica (local copy of the Vault's Notes) and the HTTP client for the Mac's
// /vault API (PLAN.md Phase 30, docs/adr/0004-*). Kept as a plain Swift
// package so it builds and tests on the Mac without Xcode (`./test.sh`) and
// the app target simply imports it.
import PackageDescription

let package = Package(
    name: "OniCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "OniCore", targets: ["OniCore"]),
    ],
    targets: [
        .target(name: "OniCore"),
        .testTarget(name: "OniCoreTests", dependencies: ["OniCore"]),
    ]
)
