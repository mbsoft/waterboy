// swift-tools-version:5.9
// waterboy-imessage: Waterboy's bridge to Beeper's platform-imessage (typing indicators today).
// Build: ./build.sh (universal binary in dist/). Pinned to a reviewed commit; bump deliberately.
import PackageDescription

let package = Package(
    name: "waterboy-imessage",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/beeper/platform-imessage.git", revision: "f92a668e897bce237ce38dcf0cd0e55823ebd068"),
    ],
    targets: [
        .executableTarget(
            name: "waterboy-imessage",
            dependencies: [.product(name: "IMessage", package: "platform-imessage")]
        ),
    ]
)
