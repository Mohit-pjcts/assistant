import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import OniCore

/// What the phone does to a picture before the Mac sees it. Pictures are made
/// in the test with ImageIO itself, so HEIC, rotation flags and GPS are real.
@Suite struct PhotoPrepTests {
    private func image(width: Int, height: Int, alpha: Bool = false, noise: Bool = false,
                       color: (UInt8, UInt8, UInt8) = (200, 40, 40)) -> CGImage {
        let info = alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info)!
        if noise, let pixels = context.data?.assumingMemoryBound(to: UInt8.self) {
            var generator = SystemRandomNumberGenerator()
            for i in 0..<(width * height * 4) { pixels[i] = UInt8.random(in: 0...255, using: &generator) }
        } else if alpha {
            context.clear(CGRect(x: 0, y: 0, width: width, height: height))
        } else {
            context.setFillColor(CGColor(red: CGFloat(color.0) / 255, green: CGFloat(color.1) / 255, blue: CGFloat(color.2) / 255, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        return context.makeImage()!
    }

    private func encode(_ image: CGImage, as type: String, properties: [CFString: Any] = [:]) -> Data {
        let out = NSMutableData()
        let destination = CGImageDestinationCreateWithData(out, type as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        precondition(CGImageDestinationFinalize(destination), "could not encode \(type)")
        return out as Data
    }

    private func properties(of data: Data) -> [CFString: Any] {
        let source = CGImageSourceCreateWithData(data as CFData, nil)!
        return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
    }

    private func pixel(_ data: Data, x: Int, y: Int) -> (r: Int, g: Int, b: Int) {
        let source = CGImageSourceCreateWithData(data as CFData, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let p = context.data!.assumingMemoryBound(to: UInt8.self)
        let offset = (y * image.width + x) * 4
        return (Int(p[offset]), Int(p[offset + 1]), Int(p[offset + 2]))
    }

    @Test func aBigPictureIsShrunkToTheReadingSizeAndKeepsItsShape() throws {
        let big = encode(image(width: 4032, height: 3024), as: "public.png")
        let photo = try PhotoPrep.jpeg(from: big, filename: "IMG_1.png")
        #expect(max(photo.pixelWidth, photo.pixelHeight) == 1568)
        #expect(photo.pixelWidth > photo.pixelHeight)
        #expect(abs(Double(photo.pixelWidth) / Double(photo.pixelHeight) - 4032.0 / 3024.0) < 0.01)
        #expect(photo.data.prefix(2) == Data([0xFF, 0xD8]))                    // really a JPEG
        #expect(photo.filename == "IMG_1.jpg" && photo.mimeType == "image/jpeg")
        #expect(photo.data.count <= PhotoPrep.maxBytes)
    }

    @Test func aSmallPictureIsNeverEnlarged() throws {
        let photo = try PhotoPrep.jpeg(from: encode(image(width: 200, height: 100), as: "public.png"))
        #expect(photo.pixelWidth == 200 && photo.pixelHeight == 100)
    }

    @Test func anIPhonesHEICBecomesAJpeg() throws {
        let heic = encode(image(width: 3000, height: 2000), as: "public.heic")
        let photo = try PhotoPrep.jpeg(from: heic, filename: "IMG_2.HEIC")
        #expect(photo.data.prefix(2) == Data([0xFF, 0xD8]))
        #expect(max(photo.pixelWidth, photo.pixelHeight) == 1568)
        #expect(photo.filename == "IMG_2.jpg")
    }

    @Test func theRotationFlagIsAppliedToThePixelsBecauseMetadataIsDropped() throws {
        // Stored landscape but flagged "rotate 90 degrees": it is a portrait photo.
        let flagged = encode(image(width: 600, height: 300), as: "public.jpeg", properties: [kCGImagePropertyOrientation: 6])
        let photo = try PhotoPrep.jpeg(from: flagged)
        #expect(photo.pixelWidth == 300 && photo.pixelHeight == 600)
        #expect(properties(of: photo.data)[kCGImagePropertyOrientation] as? Int ?? 1 == 1)
    }

    @Test func locationAndCameraDetailsAreNotSent() throws {
        let located = encode(image(width: 400, height: 300), as: "public.jpeg", properties: [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 22.28, kCGImagePropertyGPSLatitudeRef: "N",
                                            kCGImagePropertyGPSLongitude: 114.15, kCGImagePropertyGPSLongitudeRef: "E"],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Apple", kCGImagePropertyTIFFModel: "iPhone"],
        ])
        #expect(properties(of: located)[kCGImagePropertyGPSDictionary] != nil)      // the input really had it
        let out = properties(of: try PhotoPrep.jpeg(from: located).data)
        #expect(out[kCGImagePropertyGPSDictionary] == nil)
        #expect((out[kCGImagePropertyTIFFDictionary] as? [CFString: Any])?[kCGImagePropertyTIFFMake] == nil)
    }

    @Test func aTransparentPictureIsPutOnWhiteNotBlack() throws {
        let photo = try PhotoPrep.jpeg(from: encode(image(width: 100, height: 100, alpha: true), as: "public.png"))
        let p = pixel(photo.data, x: 50, y: 50)
        #expect(p.r > 240 && p.g > 240 && p.b > 240)
    }

    @Test func aHeavyPictureIsCompressedUnderTheMacsCap() throws {
        let noisy = encode(image(width: 2400, height: 2400, noise: true), as: "public.png")
        let photo = try PhotoPrep.jpeg(from: noisy)
        #expect(photo.data.count <= PhotoPrep.maxBytes)
    }

    @Test func whatCannotBeShrunkEnoughIsRefusedNotSentOversize() {
        let noisy = encode(image(width: 1200, height: 1200, noise: true), as: "public.png")
        #expect(throws: PhotoPrepError.tooLarge) { try PhotoPrep.jpeg(from: noisy, maxBytes: 20_000) }
    }

    @Test func somethingThatIsNotAPictureIsRefused() {
        #expect(throws: PhotoPrepError.unreadable) { try PhotoPrep.jpeg(from: Data("not a picture".utf8)) }
        #expect(throws: PhotoPrepError.unreadable) { try PhotoPrep.jpeg(from: Data()) }
    }
}
