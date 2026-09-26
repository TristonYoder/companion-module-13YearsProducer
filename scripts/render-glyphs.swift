#!/usr/bin/env swift
//
// Renders the Timer Entry keypad's key faces as 72×72 transparent PNGs in
// Inter — the app's own typeface — and writes them into `src/glyphs.ts` as
// base64 constants the presets hand Companion via each button style's `png64`.
//
// Why pre-render at all: Companion draws button text in its own bundled font,
// so a keypad labelled with it would be the one surface in this system whose
// digits don't match the Producer, the web pager, and the ESP32 pagers. In
// particular Inter's "zero" OpenType feature (a slashed zero) is on
// app-wide — `Font.inter(size:weight:)` turns it on through CTFontDescriptor,
// and `Hardware/esp32/tools/generate_fonts.py` bakes the same substitution
// into the pagers' bitmap fonts — so an unslashed Companion `0` reads as a
// different system. This script goes through the same CoreText path with the
// same feature enabled, so the glyphs are drawn by the same shaper the app
// draws with.
//
// A note on weight: `TimeEntryKeypad` actually labels its keys in the *system*
// monospaced face at `.medium`, not in Inter (only the popover's screen —
// buffer and preview — uses `Font.inter`). Inter-Medium is the closest Inter
// equivalent, and is what this renders; change `keyWeight` below to move the
// whole pad in one line.
//
// Usage (no dependencies beyond a Swift toolchain — nothing is added to
// package.json, and the module builds and runs from the generated file alone):
//
//   swift scripts/render-glyphs.swift
//   swift scripts/render-glyphs.swift --fonts /path/to/Fonts --out src/glyphs.ts
//
// Inter is licensed under the SIL Open Font License — see Inter-LICENSE.txt in
// this repo, copied from the fonts directory below.

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Options

let defaultFontsDirectory = "/Users/tyoder/Projects/13years/Sources/Shared/Resources/Fonts"
let defaultOutputPath = "src/glyphs.ts"

func option(_ name: String, default fallback: String) -> String {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return fallback }
    return arguments[index + 1]
}

let fontsDirectory = option("--fonts", default: defaultFontsDirectory)
let outputPath = option("--out", default: defaultOutputPath)

/// 512×512, well above the 72×72 bitmap a Stream Deck key actually shows:
/// Companion downsamples a larger `png64` cleanly, and the surfaces that are
/// bigger than 72px (Stream Deck Plus's touch strip, Satellite surfaces, the
/// web UI's own button previews at any zoom) get a glyph that was never
/// upscaled. The cost is bundle size, which is base64 PNG of mostly
/// transparent pixels and compresses to very little.
let canvasSize: CGFloat = 512
/// The 46pt this was drawn at on a 72px canvas, kept in proportion.
let pointSize: CGFloat = canvasSize * 46 / 72
let keyWeight = "Inter-Medium"

/// Two inks, because a key's face has to survive its own feedback. The glyphs
/// are drawn on transparency so the preset's `bgcolor` shows through — which
/// means a white glyph vanishes the moment a feedback repaints that background
/// a light colour (Clear and Backspace going amber the instant you start
/// typing, Enter going green when the buffer parses). Every lit state gets the
/// dark ink instead; see `litFace` in src/presets.ts.
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
        // CueState.swift's own near-black — the colour the app puts on its
        // yellow Standby ground, which is exactly this problem one layer up.
        id: "dark",
        mapName: "TIMER_ENTRY_GLYPHS_DARK",
        color: CGColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1),
        describe: "near-black ink, for a key a feedback has lit up"
    ),
]

// MARK: - Keys
//
// One entry per key on the app's grid (`TimeEntryKeypad`), keyed by the id
// `src/presets.ts` looks them up by.

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
    // U+2212 MINUS SIGN, as the app's grid uses — not a hyphen.
    Key(id: "minus", text: "\u{2212}"),
    Key(id: "enter", text: "\u{21B5}"),
    Key(id: "backspace", text: "\u{232B}"),
]

// MARK: - Font registration

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
            // Already registered is fine; anything else is worth seeing.
            let message = error?.takeRetainedValue().localizedDescription ?? "unknown error"
            FileHandle.standardError.write("note: \(url.lastPathComponent): \(message)\n".data(using: .utf8)!)
        }
    }
}

/// The same descriptor `Font.inter(size:weight:)` builds: a PostScript name
/// plus Inter's `zero` feature turned on, so the slashed zero substitution
/// happens here exactly as it does on every other surface.
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

/// True when the face itself can draw every character — CoreText silently
/// falls back to another font when it can't, which is fine for `↵`/`⌫` (Inter
/// has no such glyphs) but would be a surprise for anything else.
func covers(_ text: String, font: CTFont) -> Bool {
    let scalars = Array(text.unicodeScalars)
    var characters = scalars.flatMap { Array(String($0).utf16) }
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    let complete = CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count)
    return complete && !glyphs.contains(0)
}

// MARK: - Rendering

/// One glyph on a fully transparent canvas, so the preset's own `bgcolor` and
/// every feedback that repaints it (Enter going green, the lit sign key) keep
/// working untouched underneath the glyph.
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

    // Center on the glyph's *ink*, not its typographic box: a keypad's faces
    // are single characters with wildly different bearings ("1" vs "⌫"), and
    // centering on advance width leaves them visibly off-center from each other.
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

// MARK: - Main

registerFonts(in: fontsDirectory)
let font = interFont(keyWeight, size: pointSize)

// A wrong PostScript name doesn't error — CoreText hands back the system font
// — so check a digit is really coming from Inter before rendering 19 of them.
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
// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  swift scripts/render-glyphs.swift
//
// The Timer Entry keypad's key faces, drawn in Inter (\(keyWeight), \(Int(pointSize))pt) with
// Inter's "zero" OpenType feature on — the same CoreText path
// `Font.inter(size:weight:)` takes in the Producer app, so the slashed zero
// and the letterforms match the app's own screen, the web pager, and the ESP32
// pagers' bitmap fonts rather than Companion's bundled font.
//
// Each value is a base64 \(Int(canvasSize))×\(Int(canvasSize)) PNG on a fully transparent background, so a
// preset's `bgcolor` and any feedback that repaints it still show through.
// There are two sets of the same faces: white for a key on its normal dark
// background, near-black for one a feedback has lit up, since white on amber
// or green is a key that has effectively gone blank. See
// scripts/render-glyphs.swift for the renderer, and Inter-LICENSE.txt for
// Inter's license.
"""

let output = header + "\n" + maps.joined(separator: "\n\n") + "\n"
try output.write(toFile: outputPath, atomically: true, encoding: .utf8)

// The generated file is linted like any other source file, and a 2KB base64
// string on one line is not how Prettier would have written it — hand it over
// rather than trying to predict its line breaking here.
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
