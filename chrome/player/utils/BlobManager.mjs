// @ts-check
export class BlobManager {
  /**
  * @param {Array<BlobPart>} data
   * @param {string} mimeType
   * @return {Blob}
   */
  static createBlob(data, mimeType) {
    return new Blob(data, {type: mimeType});
  }

  /**
   * @param {Blob} blob
   * @param {string} type - 'arraybuffer' or 'text'.
   * @return {Promise<ArrayBuffer|string>}
   */
  static async getDataFromBlob(blob, type) {
    if (type === 'arraybuffer') {
      return blob.arrayBuffer();
    }
    // readAsText honours the charset in the blob's type and a BOM; blob.text() always reads UTF-8.
    const reader = new FileReader();
    reader.readAsText(blob);
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error);
    });
  }
}
