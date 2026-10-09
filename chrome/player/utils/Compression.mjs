// @ts-check

// zlib compression (RFC 1950) with the browser's own CompressionStream (Firefox 113), in
// place of the vendored pako 3.0.2, which only VideoAligner used. Same format as pako's
// deflate() and inflate() without options, so data saved by either reads with the other.
// Not the same bytes: Firefox compresses the analyzer's buffers differently from pako
// (measured), and either inflates the other's.

/**
 * Compresses bytes as zlib.
 * @param {BufferSource} data
 * @return {Promise<Uint8Array>}
 */
export function deflate(data) {
  return transform(data, new CompressionStream('deflate'));
}

/**
 * Decompresses zlib bytes.
 * @param {BufferSource} data
 * @return {Promise<Uint8Array>} Over a buffer of its own, exactly as long.
 */
export function inflate(data) {
  return transform(data, new DecompressionStream('deflate'));
}

/**
 * @param {BufferSource} data
 * @param {CompressionStream|DecompressionStream} stream
 * @return {Promise<Uint8Array>}
 */
async function transform(data, stream) {
  const out = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
