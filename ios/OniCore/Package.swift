// swift-tools-version: 6.0
//
// OniCore — the iPhone app's logic with no UI: the Vault sync engine, the
// Replica (local copy of the Vault's Notes), the HTTP client for the Mac's
// /vault API, and the pure logic the screens sit on (Markdown blocks,
// wikilinks, search, folder tree). PLAN.md Phase 30, docs/adr/0004-*. Kept as
// a plain Swift package so it builds and tests on the Mac with `./test.sh`
// and the app target simply imports it.
//
// One dependency: Apple's swift-markdown (cmark-gfm) for parsing Markdown
// blocks — tables and nested lists are where a hand-rolled parser goes wrong.
import PackageDescription

let package = Package(
    name: "OniCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "OniCore", targets: ["OniCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", from: "0.5.0"),
    ],
    targets: [
        .target(
            name: "OniCore",
            dependencies: [.product(name: "Markdown", package: "swift-markdown")]),
        .testTarget(name: "OniCoreTests", dependencies: ["OniCore"]),
    ]
)
