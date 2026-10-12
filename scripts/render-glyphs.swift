#!/usr/bin/env swift

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let defaultFontsDirectory = "/Users/tyoder/Projects/13years/Sources/Shared/Resources/Fonts"
let defaultOutputPath = "src/glyphs.ts"

func option(_ name: String, default fallback: String) -> String {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return fallback }
    return arguments[index + 1]
}

let fontsDirectory = option("--fonts", default: defaultFontsDirectory)
let outputPath = option("--out", default: defaultOutputPath)

let canvasSize: CGFloat = 512
let pointSize: CGFloat = canvasSize * 46 / 72
let keyWeight = "Inter-Medium"

struct Ink {
    let id: String
    let mapName: String
    let color: CGColor
    let describe: String
}

let inks: [Ink] = [
    Ink(
        id: "light",
        mapName: "TIMER_ENTRY_GLYPHS",
        color: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
        describe: "white ink, for a key sitting on its normal dark background"
    ),
    Ink(
        id: "dark",
        mapName: "TIMER_ENTRY_GLYPHS_DARK",
        color: CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1),
        describe: "near-black ink, for a key a feedback has lit up"
    ),
]

struct Key {
    let id: String
    let text: String
}

let keys: [Key] = [
    Key(id: "0", text: "0"),
    Key(id: "1", text: "1"),
    Key(id: "2", text: "2"),
    Key(id: "3", text: "3"),
    Key(id: "4", text: "4"),
    Key(id: "5", text: "5"),
    Key(id: "6", text: "6"),
    Key(id: "7", text: "7"),
    Key(id: "8", text: "8"),
    Key(id: "9", text: "9"),
    Key(id: "h", text: "h"),
    Key(id: "m", text: "m"),
    Key(id: "s", text: "s"),
    Key(id: "colon", text: ":"),
    Key(id: "clear", text: "C"),
    Key(id: "plus", text: "+"),
    Key(id: "minus", text: "\u{2212}"),
    Key(id: "enter", text: "\u{21B5}"),
    Key(id: "backspace", text: "\u{232B}"),
]

func registerFonts(in directory: String) {
    let urls = (try? FileManager.default.contentsOfDirectory(atPath: directory))?
        .filter { $0.hasPrefix("Inter-") && $0.hasSuffix(".ttf") }
        .map { URL(fileURLWithPath: directory).appendingPathComponent($0) } ?? []

    guard !urls.isEmpty else {
        FileHandle.standardError.write("No Inter-*.ttf found in \(directory)\n".data(using: .utf8)!)
        exit(1)
    }

    for url in urls {
        var error: Unmanaged<CFError>?
        if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            let message = error?.takeRetainedValue().localizedDescription ?? "unknown error"
            FileHandle.standardError.write("note: \(url.lastPathComponent): \(message)\n".data(using: .utf8)!)
        }
    }
}

func interFont(_ postScriptName: String, size: CGFloat) -> CTFont {
    let attributes: [CFString: Any] = [
        kCTFontNameAttribute: postScriptName as CFString,
        kCTFontFeatureSettingsAttribute: [
            [
                kCTFontOpenTypeFeatureTag: "zero" as CFString,
                kCTFontOpenTypeFeatureValue: 1,
            ] as CFDictionary
        ],
    ]
    let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
    return CTFontCreateWithFontDescriptor(descriptor, size, nil)
}

func covers(_ text: String, font: CTFont) -> Bool {
    let scalars = Array(text.unicodeScalars)
    var characters = scalars.flatMap { Array(String($0).utf16) }
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    let complete = CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count)
    return complete && !glyphs.contains(0)
}

func renderPNG(text: String, font: CTFont, ink: CGColor) -> Data {
    let attributed = NSAttributedString(
        string: text,
        attributes: [
            kCTFontAttributeName as NSAttributedString.Key: font,
            kCTForegroundColorAttributeName as NSAttributedString.Key: ink,
        ]
    )
    let line = CTLineCreateWithAttributedString(attributed)

    guard
        let context = CGContext(
            data: nil,
            width: Int(canvasSize),
            height: Int(canvasSize),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        FileHandle.standardError.write("Could not create a bitmap context\n".data(using: .utf8)!)
        exit(1)
    }

    context.setAllowsAntialiasing(true)
    context.setShouldSmoothFonts(true)

    let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    context.textPosition = CGPoint(
        x: (canvasSize - ink.width) / 2 - ink.minX,
        y: (canvasSize - ink.height) / 2 - ink.minY
    )
    CTLineDraw(line, context)

    guard let image = context.makeImage() else {
        FileHandle.standardError.write("Could not snapshot the bitmap context\n".data(using: .utf8)!)
        exit(1)
    }

    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        FileHandle.standardError.write("Could not create a PNG encoder\n".data(using: .utf8)!)
        exit(1)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        FileHandle.standardError.write("Could not encode the PNG\n".data(using: .utf8)!)
        exit(1)
    }
    return data as Data
}

registerFonts(in: fontsDirectory)
let font = interFont(keyWeight, size: pointSize)

let resolvedName = CTFontCopyPostScriptName(font) as String
if resolvedName != keyWeight {
    FileHandle.standardError.write(
        "Expected \(keyWeight), got \(resolvedName) — are the fonts in \(fontsDirectory)?\n".data(using: .utf8)!
    )
    exit(1)
}

for key in keys where !covers(key.text, font: font) {
    FileHandle.standardError.write(
        "note: \(key.id) (\(key.text)) isn't in \(keyWeight) — CoreText is substituting another face for it\n"
            .data(using: .utf8)!
    )
}

var maps: [String] = []
for ink in inks {
    var lines: [String] = []
    for key in keys {
        let base64 = renderPNG(text: key.text, font: font, ink: ink.color).base64EncodedString()
        lines.append("\t'\(key.id)': '\(base64)',")
    }
    maps.append(
        """
        /** Key id (as `src/presets.ts` names it) → base64 PNG — \(ink.describe). */
        export const \(ink.mapName): Record<string, string> = {
        \(lines.joined(separator: "\n"))
        }
        """
    )
}

let header = """
"""

let output = header + "\n" + maps.joined(separator: "\n\n") + "\n"
try output.write(toFile: outputPath, atomically: true, encoding: .utf8)

let prettier = Process()
prettier.executableURL = URL(fileURLWithPath: "/usr/bin/env")
prettier.arguments = ["npx", "--no-install", "prettier", "--write", outputPath]
prettier.standardOutput = FileHandle.nullDevice
try? prettier.run()
prettier.waitUntilExit()
if prettier.terminationStatus != 0 {
    FileHandle.standardError.write(
        "note: couldn't run prettier on \(outputPath) — run `npx prettier --write \(outputPath)` before committing\n"
            .data(using: .utf8)!
    )
}

FileHandle.standardError.write(
    "Wrote \(keys.count * inks.count) glyphs (\(keys.count) keys × \(inks.count) inks, \(Int(canvasSize))px) to \(outputPath)\n"
        .data(using: .utf8)!
)
