// swift-tools-version: 5.9
import PackageDescription

let homebrewInclude = "/opt/homebrew/include"
let homebrewLib = "/opt/homebrew/lib"
let localInclude = "/usr/local/include"
let localLib = "/usr/local/lib"

let package = Package(
    name: "NoopPush",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "NoopPush", targets: ["NoopPush"])],
    targets: [
        .target(
            name: "CNoopZstd",
            publicHeadersPath: "include",
            cSettings: [
                .unsafeFlags(["-I\(homebrewInclude)", "-I\(localInclude)"], .when(platforms: [.macOS])),
            ],
            linkerSettings: [
                .linkedLibrary("zstd", .when(platforms: [.macOS])),
                .unsafeFlags(["-L\(homebrewLib)", "-L\(localLib)"], .when(platforms: [.macOS])),
            ]
        ),
        .target(
            name: "NoopPush",
            dependencies: [
                .target(name: "CNoopZstd", condition: .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(
            name: "NoopPushTests",
            dependencies: ["NoopPush"],
            resources: [.process("Resources")]
        ),
    ]
)
