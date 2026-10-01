import Foundation

/// How large to decode a photo for the size it is drawn at.
public enum ImageSizing {
    /// The longest side, in pixels, to decode a `width` × `height` photo at
    /// so it covers a `pixels`-wide square (`fill`, which crops the long
    /// side, so the short side has to reach `pixels`) or fits in `pixels`
    /// (`fit`). Never larger than the photo itself.
    public static func maxPixelSize(width: Int?, height: Int?, pixels: Int, fill: Bool) -> Int {
        let pixels = max(1, pixels)
        guard let width, let height, width > 0, height > 0 else { return pixels }
        let long = max(width, height)
        let needed = fill ? Int((Double(pixels) * Double(long) / Double(min(width, height))).rounded(.up)) : pixels
        return min(needed, long)
    }
}
