// PNG header reading (screenshot size assertions).

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. Throws on anything that is not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.byteLength < 24 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
