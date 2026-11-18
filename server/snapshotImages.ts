// Photos of preserved research listings are stored in SQLite
// (market_listing_snapshot_images). OLX and Vinted serve ~50-80 KB WebP, but
// Allegro Lokalnie's gallery links are the uploaded originals: 1.3 MB JPEGs
// on average, 64% of a real 748 MB database. They are shown in the research
// snapshot view and can seed a resale draft's photos, neither of which needs
// more than 1600 px, so an oversized photo is stored as a WebP that size.
import sharp from 'sharp';

/** Photos larger than this are re-encoded when stored. */
export const SNAPSHOT_IMAGE_SHRINK_BYTES = 300 * 1024;
/** Long edge of a re-encoded photo. */
export const SNAPSHOT_IMAGE_MAX_EDGE = 1600;
const WEBP_QUALITY = 80;
// GIFs can be animated; everything else a marketplace serves is a still photo.
const STILL_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/**
 * A smaller copy of an oversized listing photo: WebP, at most
 * SNAPSHOT_IMAGE_MAX_EDGE px on its long side, the camera's rotation applied
 * and metadata dropped. Null keeps the original: the photo is small enough,
 * an animation, unreadable, or would not get smaller.
 */
export async function shrinkSnapshotImage(data: Uint8Array, mime: string): Promise<{ mime: 'image/webp'; data: Buffer } | null> {
  if (data.byteLength <= SNAPSHOT_IMAGE_SHRINK_BYTES || !STILL_FORMATS.has(mime)) return null;
  try {
    const smaller = await sharp(data, { failOn: 'error', limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: SNAPSHOT_IMAGE_MAX_EDGE, height: SNAPSHOT_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return smaller.byteLength < data.byteLength ? { mime: 'image/webp', data: smaller } : null;
  } catch {
    return null;
  }
}
