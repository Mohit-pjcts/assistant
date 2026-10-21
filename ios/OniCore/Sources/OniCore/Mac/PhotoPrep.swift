import CoreGraphics
import Foundation
import ImageIO

/// A photo ready to upload to the Mac: always a JPEG.
public struct PreparedPhoto: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let data: Data
    public let filename: String
    public let pixelWidth: Int
    public let pixelHeight: Int
    public var mimeType: String { "image/jpeg" }

    public init(id: UUID = UUID(), data: Data, filename: String, pixelWidth: Int, pixelHeight: Int) {
        self.id = id
        self.data = data
        self.filename = filename
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }
}

public enum PhotoPrepError: Error, Equatable, CustomStringConvertible {
    case unreadable
    case tooLarge

    public var description: String {
        switch self {
        case .unreadable: "That file is not a picture the phone can read."
        case .tooLarge: "That picture is too large to send, even shrunk."
        }
    }
}

/// Turns whatever the photo library hands over (an iPhone's HEIC, a PNG with
/// transparency, a camera JPEG rotated by a flag) into a plain JPEG the Mac's
/// `/uploads` accepts (PLAN.md Phase 31 D9: the Mac refuses HEIC).
///
/// Three things are done deliberately, not incidentally:
/// - the picture is shrunk to the long edge Claude reads it at anyway (the Mac
///   downsamples to 1568px too), which also keeps it under the Mac's 3.5MB cap;
/// - the EXIF rotation is applied to the pixels, since the metadata is dropped;
/// - all metadata is dropped, so the photo's GPS position and camera details are
///   not sent to the Mac or the model.
public enum PhotoPrep {
    public static let maxLongEdge = 1568
    /// The Mac rejects images over 3.5MB; stay clear of it.
    public static let maxBytes = 3_000_000

    public static func jpeg(from data: Data, filename: String = "photo", maxLongEdge: Int = PhotoPrep.maxLongEdge,
                            maxBytes: Int = PhotoPrep.maxBytes) throws -> PreparedPhoto {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            throw PhotoPrepError.unreadable
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        guard let width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0 else { throw PhotoPrepError.unreadable }

        // Never enlarge a small picture.
        let longEdge = min(maxLongEdge, max(width, height))
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let image = opaque(decoded) else { throw PhotoPrepError.unreadable }

        for quality in [0.82, 0.65, 0.45, 0.3] {
            if let encoded = encode(image, quality: quality), encoded.count <= maxBytes {
                return PreparedPhoto(data: encoded, filename: jpegName(filename),
                                     pixelWidth: image.width, pixelHeight: image.height)
            }
        }
        throw PhotoPrepError.tooLarge
    }

    /// JPEG has no transparency: put a see-through picture on white rather than
    /// letting it come out black.
    private static func opaque(_ image: CGImage) -> CGImage? {
        let space = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        return context.makeImage()
    }

    private static func encode(_ image: CGImage, quality: Double) -> Data? {
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }

    private static func jpegName(_ name: String) -> String {
        let base = (name as NSString).deletingPathExtension
        return (base.isEmpty ? "photo" : base) + ".jpg"
    }
}
