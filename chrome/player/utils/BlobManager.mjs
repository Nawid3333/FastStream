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
    const reader = new FileReader();

    if (type === 'arraybuffer') {
      reader.readAsArrayBuffer(blob);
    } else {
      reader.readAsText(blob);
    }

    return new Promise((resolve, reject) => {
      reader.onload = () => {
        resolve(reader.result);
      };

      reader.onerror = () => {
        reject(reader.error);
      };
    });
  }
}
