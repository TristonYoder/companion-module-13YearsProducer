#!/usr/bin/env swift
//
// Renders this module's button iconography — Font Awesome 6 Free Solid glyphs,
// plus the shared gradient plate — into `src/icons.ts` as base64 PNGs that the
// layered presets hand Companion as `image` elements.
//
// Why pre-render rather than let Companion draw them: a layered button's `text`
// element can only use Companion's own bundled faces (`companion-sans` /
// `companion-mono`), so an icon cannot be a text glyph. Icons have to arrive as
// image layers, and an image layer takes a base64 PNG. Same pipeline the Timer
// Entry keypad already uses for its Inter digits — see render-glyphs.swift.
//
// Why Font Awesome specifically: it is licensable for redistribution. The icons
// are CC BY 4.0 and the fonts SIL OFL 1.1 (see Font-Awesome-LICENSE.txt in this
// repo). SF Symbols, the obvious Mac-native alternative, may only be used in
// apps for Apple platforms — a Companion module runs on Windows and Linux too,
// so shipping SF Symbol artwork in it would be a license violation.
//
// Usage (no dependencies beyond a Swift toolchain — the generated file is
// committed, so nobody else needs the font or this script to build the module):
//
//   swift scripts/render-icons.swift
//   swift scripts/render-icons.swift --fonts /path/to/Font-Awesome/otfs --out src/icons.ts

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Options

let defaultFontsDirectory = "/Users/tyoder/Projects/Streamdeck/Font-Awesome/otfs"
let defaultOutputPath = "src/icons.ts"

func option(_ name: String, default fallback: String) -> String {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return fallback }
    return arguments[index + 1]
}

let fontsDirectory = option("--fonts", default: defaultFontsDirectory)
let outputPath = option("--out", default: defaultOutputPath)

/// 512×512 for the same reason the Inter glyphs are: Companion downsamples a
/// larger image cleanly, and surfaces bigger than a 72px Stream Deck key get
/// artwork that was never upscaled.
let canvasSize: CGFloat = 512
/// Generous margin — an icon that fills its button edge-to-edge reads as noise
/// on a 72px key, and a layered button puts a text label under it.
let iconPointSize: CGFloat = 300
/// The plated icons are opaque edge to edge, so they cost roughly 8x what a
/// transparent glyph does at the same size. 288px is still 4x a 72px Stream
/// Deck key — well past what any surface shows — and keeps the generated file
/// a sane size.
let plateCanvasSize: CGFloat = 288
let platePointSize: CGFloat = 168

// MARK: - The icon set
//
// Font Awesome 6 Free Solid codepoints (from the pack's own metadata/icons.json).
// Keyed by the name `src/presets.ts` refers to them by, which is deliberately
// the button's job ("waypointGo") rather than the glyph's ("flag") — swapping
// which glyph a button wears is then a one-line change here.

let icons: [(id: String, codepoint: UInt32, faName: String)] = [
    // Timer transport
    ("timerStart", 0xF04B, "play"),
    ("timerPause", 0xF04C, "pause"),
    ("timerReset", 0xF2EA, "rotate-left"),
    ("timerAdd", 0x002B, "plus"),
    ("timerSubtract", 0xF068, "minus"),
    ("timerClock", 0xF017, "clock"),
    ("stopwatch", 0xF2F2, "stopwatch"),
    // Service navigation
    ("planPrevious", 0xF053, "chevron-left"),
    ("planNext", 0xF054, "chevron-right"),
    ("planNextService", 0xF050, "forward-fast"),
    ("planList", 0xF0CB, "list-ol"),
    // Waypoints
    ("waypointGo", 0xF3C5, "location-dot"),
    ("waypointFlag", 0xF024, "flag"),
    // Schedules
    ("schedule", 0xF073, "calendar-days"),
    ("scheduleGoLive", 0xF0E7, "bolt"),
    // Messages & notifications
    ("message", 0xF075, "comment"),
    ("messageSend", 0xF1D8, "paper-plane"),
    ("notificationDismiss", 0xF1F6, "bell-slash"),
    ("messagesClear", 0xF51A, "broom"),
    // Cues
    ("cueClear", 0xF00D, "xmark"),
    ("cueGo", 0xF00C, "check"),
    ("roles", 0xF500, "user-group"),
    // Integrations & status
    ("pcoSync", 0xF2F1, "rotate"),
    ("cloud", 0xF0C2, "cloud"),
    ("status", 0xF519, "tower-broadcast"),
    ("ok", 0xF058, "circle-check"),
    ("warning", 0xF071, "triangle-exclamation"),
    ("settings", 0xF013, "gear"),
    ("producerControl", 0xF1DE, "sliders"),
    ("livePreview", 0xF26C, "tv"),
]

// MARK: - Font loading

func solidFont(size: CGFloat) -> CTFont? {
    let candidates = [
        "\(fontsDirectory)/Font Awesome 6 Free-Solid-900.otf",
        "\(fontsDirectory)/fa-solid-900.ttf",
    ]
    for path in candidates where FileManager.default.fileExists(atPath: path) {
        guard let provider = CGDataProvider(url: URL(fileURLWithPath: path) as CFURL),
              let cgFont = CGFont(provider) else { continue }
        // Created straight from the file rather than by PostScript name, so the
        // font never has to be installed on the machine running this.
        return CTFontCreateWithGraphicsFont(cgFont, size, nil, nil)
    }
    return nil
}

// MARK: - Rendering

func newContext() -> CGContext {
    let context = CGContext(
        data: nil,
        width: Int(canvasSize),
        height: Int(canvasSize),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    return context
}

func encodePNG(_ context: CGContext) -> Data? {
    guard let image = context.makeImage() else { return nil }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        return nil
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

func renderIcon(codepoint: UInt32, font: CTFont, ink: CGColor) -> Data? {
    guard let scalar = Unicode.Scalar(codepoint) else { return nil }
    let text = String(Character(scalar))
    // CoreText's own attribute keys, not AppKit's `.font`/`.foregroundColor` —
    // this script imports no UI framework, so those don't exist here.
    let attributed = NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    // Centre on the glyph's own inked bounds, not its typographic metrics —
    // Font Awesome's glyphs sit on wildly different baselines and advance
    // widths, and centring by metrics leaves half of them visibly off-centre.
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    guard bounds.width > 0, bounds.height > 0 else { return nil }

    let context = newContext()
    context.textPosition = CGPoint(
        x: (canvasSize - bounds.width) / 2 - bounds.origin.x,
        y: (canvasSize - bounds.height) / 2 - bounds.origin.y
    )
    CTLineDraw(line, context)
    return encodePNG(context)
}

/// The shared plate every info/action button sits on: a vertical light-to-dark
/// grey wash that gives a flat colour some depth without competing with the
/// icon over it. Two stops, both here — change them and every button that uses
/// the plate changes with them.
func renderGradient() -> Data? {
    let context = newContext()
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let gradient = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            CGColor(srgbRed: 198 / 255, green: 198 / 255, blue: 198 / 255, alpha: 1),
            CGColor(srgbRed: 74 / 255, green: 74 / 255, blue: 74 / 255, alpha: 1),
        ] as CFArray,
        locations: [0, 1]
    ) else { return nil }
    // Top-to-bottom in image space: CoreGraphics' origin is bottom-left, so the
    // light stop belongs at y = canvasSize.
    context.drawLinearGradient(
        gradient,
        start: CGPoint(x: 0, y: canvasSize),
        end: CGPoint(x: 0, y: 0),
        options: []
    )
    return encodePNG(context)
}

/// Icon over the gradient plate, flattened into one image.
///
/// Companion's *module* preset API gives a button exactly one image slot
/// (`png64`) — the layered element stack that Companion 5.0 draws with is
/// composed in its UI, and a module can only declare element stacks through
/// `@companion-module/base` 2.x, which Companion 5.0.4 cannot load. So the two
/// layers are flattened here instead of being stacked by Companion — see
/// https://github.com/TristonYoder/companion-module-13YearsProducer/issues/1
///
/// The plate is drawn at partial alpha so the button's own `bgcolor` still
/// reads through underneath it, which is what keeps a feedback's recolour
/// visible through the plate.
func renderPlatedIcon(codepoint: UInt32, font: CTFont, ink: CGColor, plateAlpha: CGFloat) -> Data? {
    guard let scalar = Unicode.Scalar(codepoint) else { return nil }
    let canvasSize = plateCanvasSize
    let context = CGContext(
        data: nil,
        width: Int(canvasSize),
        height: Int(canvasSize),
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)

    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    if let gradient = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            CGColor(srgbRed: 198 / 255, green: 198 / 255, blue: 198 / 255, alpha: plateAlpha),
            CGColor(srgbRed: 74 / 255, green: 74 / 255, blue: 74 / 255, alpha: plateAlpha),
        ] as CFArray,
        locations: [0, 1]
    ) {
        context.drawLinearGradient(
            gradient,
            start: CGPoint(x: 0, y: canvasSize),
            end: CGPoint(x: 0, y: 0),
            options: []
        )
    }

    let text = String(Character(scalar))
    let attributed = NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    // Sits slightly above centre: a preset's label prints over the lower third.
    context.textPosition = CGPoint(
        x: (canvasSize - bounds.width) / 2 - bounds.origin.x,
        y: (canvasSize - bounds.height) / 2 - bounds.origin.y + canvasSize * 0.10
    )
    CTLineDraw(line, context)
    return encodePNG(context)
}

// MARK: - Main

guard let font = solidFont(size: iconPointSize) else {
    FileHandle.standardError.write("error: couldn't load Font Awesome Solid from \(fontsDirectory)\n".data(using: .utf8)!)
    exit(1)
}

let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
let ink = CGColor(srgbRed: 26 / 255, green: 26 / 255, blue: 26 / 255, alpha: 1)

var lightEntries: [String] = []
var darkEntries: [String] = []
var plateEntries: [String] = []
var rendered = 0
for icon in icons {
    guard let light = renderIcon(codepoint: icon.codepoint, font: font, ink: white),
          let dark = renderIcon(codepoint: icon.codepoint, font: font, ink: ink) else {
        FileHandle.standardError.write("warning: couldn't render \(icon.id) (\(icon.faName))\n".data(using: .utf8)!)
        continue
    }
    lightEntries.append("\t/** Font Awesome: \(icon.faName) */\n\t\(icon.id): '\(light.base64EncodedString())',")
    darkEntries.append("\t/** Font Awesome: \(icon.faName) */\n\t\(icon.id): '\(dark.base64EncodedString())',")
    if let plateFont = solidFont(size: platePointSize),
       let plated = renderPlatedIcon(codepoint: icon.codepoint, font: plateFont, ink: white, plateAlpha: 0.55) {
        plateEntries.append("\t/** Font Awesome: \(icon.faName), over the gradient plate */\n\t\(icon.id): '\(plated.base64EncodedString())',")
    }
    rendered += 1
}

guard let gradient = renderGradient() else {
    FileHandle.standardError.write("error: couldn't render the gradient plate\n".data(using: .utf8)!)
    exit(1)
}

let header = """
// GENERATED FILE — do not edit by hand.
//
// Regenerate with:  swift scripts/render-icons.swift
//
// Button iconography for the layered presets: Font Awesome 6 Free Solid glyphs
// as base64 \(Int(canvasSize))×\(Int(canvasSize)) PNGs on a transparent background, plus the grey
// gradient plate the info/action buttons sit on.
//
// A layered button stacks these bottom-to-top as Companion `elements`:
//   box   — the flat colour
//   image — BUTTON_GRADIENT, the plate
//   image — ICONS[...], the glyph
//   text  — the label
//
// Two ink cuts of every glyph: white for a plate or dark colour, near-black for
// a button a feedback has lit amber or green, where white ink would vanish.
//
// Font Awesome Free is CC BY 4.0 (icons) and SIL OFL 1.1 (fonts) — see
// Font-Awesome-LICENSE.txt. See scripts/render-icons.swift for the renderer.
"""

let output = """
\(header)

/** Icon id (as `src/presets.ts` names it) → base64 PNG, white ink. */
export const ICONS: Record<string, string> = {
\(lightEntries.joined(separator: "\n"))
}

/** The same glyphs in near-black, for a button a feedback has lit up. */
export const ICONS_DARK: Record<string, string> = {
\(darkEntries.joined(separator: "\n"))
}

/**
 * Icon already flattened onto the gradient plate — what an info or action
 * button hands Companion as its single `png64`.
 */
export const ICON_PLATES: Record<string, string> = {
\(plateEntries.joined(separator: "\n"))
}

/** The plate on its own, for a button that wants the wash with no icon. */
export const BUTTON_GRADIENT = '\(gradient.base64EncodedString())'

"""

try output.write(toFile: outputPath, atomically: true, encoding: .utf8)

let prettier = Process()
prettier.executableURL = URL(fileURLWithPath: "/usr/bin/env")
prettier.arguments = ["npx", "--no-install", "prettier", "--write", outputPath]
prettier.standardOutput = FileHandle.nullDevice
try? prettier.run()
prettier.waitUntilExit()

FileHandle.standardError.write("Wrote \(rendered) icons (×2 inks) + gradient to \(outputPath)\n".data(using: .utf8)!)
