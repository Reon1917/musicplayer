import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments

guard arguments.count == 3 else {
  fputs("Usage: swift scripts/round-app-icon.swift <input.png> <output.png>\n", stderr)
  exit(2)
}

let inputURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
let outputSize = 1024
let cornerRadius = CGFloat(outputSize) * 0.224

guard let sourceImage = NSImage(contentsOf: inputURL) else {
  fputs("Unable to read input image: \(inputURL.path)\n", stderr)
  exit(1)
}

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

guard
  let context = CGContext(
    data: nil,
    width: outputSize,
    height: outputSize,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: bitmapInfo
  )
else {
  fputs("Unable to create bitmap context\n", stderr)
  exit(1)
}

let outputRect = CGRect(x: 0, y: 0, width: outputSize, height: outputSize)
context.clear(outputRect)

let maskPath = CGPath(
  roundedRect: outputRect,
  cornerWidth: cornerRadius,
  cornerHeight: cornerRadius,
  transform: nil
)

context.addPath(maskPath)
context.clip()

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
sourceImage.draw(in: outputRect, from: .zero, operation: .copy, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()

guard let cgImage = context.makeImage() else {
  fputs("Unable to create output image\n", stderr)
  exit(1)
}

let bitmap = NSBitmapImageRep(cgImage: cgImage)
guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Unable to encode PNG\n", stderr)
  exit(1)
}

try pngData.write(to: outputURL, options: .atomic)
