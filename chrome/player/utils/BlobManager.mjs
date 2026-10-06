/**
 * Creates and reads blobs.
 */
export class BlobManager {
  /**
   * Creates a blob from data and MIME type.
   * @param {Array} data - The data to store in the blob.
   * @param {string} mimeType - The MIME type of the blob.
   * @return {Blob} The created blob.
   */
  static createBlob(data, mimeType) {
    return new Blob(data, {type: mimeType});
  }

  /**
   * Reads data from a blob as text or arraybuffer.
   * @param {Blob} blob - The blob to read from.
   * @param {string} type - The type of data to read ('arraybuffer' or 'text').
   * @return {Promise<ArrayBuffer|string>} The data from the blob.
   */
  static async getDataFromBlob(blob, type) {
    if (type === 'arraybuffer') {
      return blob.arrayBuffer();
    }
    // Text through FileReader, not blob.text(): readAsText decodes with the charset the
    // blob's type names (a playlist served as text/plain;charset=iso-8859-1), a byte order
    // mark overriding it; blob.text() reads every blob as UTF-8.
    const reader = new FileReader();
    reader.readAsText(blob);
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
    });
  }
}
