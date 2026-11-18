// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {DownloadEntry} from '../network/DownloadEntry.mjs';
import {LargeBuffer} from '../modules/LargeBuffer.mjs';
import {Utils} from './Utils.mjs';
import {withoutCredentials} from '../VideoSource.mjs';

export class FastStreamArchiveUtils {
  // Bytes per read in parseFSAFile; a test lowers it.
  static fileChunkSize = 1e9 / 4;

  /**
   * @param {WritableStream} filestream
   * @param {import('../FastStreamClient.mjs').Player|null} player
   * @param {Array<DownloadEntry>} entries
   * @param {Function} [progressCallback]
   * @return {Promise<void>} Resolves once the stream has finished the file.
   * @throws {Error} If an entry is not complete, or the stream fails.
   */
  static async writeFSAToStream(filestream, player, entries, progressCallback) {
    const writer = filestream.getWriter();
    try {
      await this.writeFSA(writer, player, entries, progressCallback);
      // A streamed save hands its file to the download here: its failure is the save's.
      await writer.close();
    } catch (e) {
      await writer.abort(e).catch(() => {});
      throw e;
    }
  }

  /**
   * The header, then each entry's header and data.
   * @param {WritableStreamDefaultWriter} writer
   * @param {import('../FastStreamClient.mjs').Player|null} player
   * @param {Array<DownloadEntry>} entries
   * @param {Function} [progressCallback]
   * @return {Promise<void>}
   */
  static async writeFSA(writer, player, entries, progressCallback) {
    const sourceObj = {};
    if (player) {
      const source = /** @type {import('../VideoSource.mjs').VideoSource} */ (player.getSource());
      sourceObj.url = source.url;
      sourceObj.identifier = source.identifier;
      sourceObj.mode = source.mode;
      // An archive may be passed on: no Cookie or Authorization.
      sourceObj.headers = withoutCredentials(source.headers || {});
    }
    const header = new TextEncoder().encode(JSON.stringify({
      version: 1,
      number_of_entries: entries.length,
      source: player ? sourceObj : null,
      currentLevel: player?.getCurrentVideoLevelID(),
      currentAudioLevel: player?.getCurrentAudioLevelID(),
    }));

    const headerPart = new ArrayBuffer(4 + header.byteLength);
    const headerView = new DataView(headerPart);
    headerView.setUint32(0, header.byteLength);
    new Uint8Array(headerPart, 4).set(header);

    await writer.write(new Uint8Array(headerPart));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.status !== DownloadStatus.DOWNLOAD_COMPLETE) {
        throw new Error('Entry is not complete!');
      }

      /** @type {*} */
      let data = null;
      if (entry.storeRaw) {
        data = await entry.getData();
        if (typeof data === 'string') {
          data = (new TextEncoder().encode(data)).buffer;
        }
      } else {
        data = /** @type {ArrayBuffer} */ (await entry.getDataFromBlob('arraybuffer'));
      }

      const dataSize = data.byteLength;
      /** @type {Object<string, string>} */
      const newHeaders = {};
      const headersWhitelist = ['content-range'];
      for (const header in entry.responseHeaders) {
        if (!Object.hasOwn(entry.responseHeaders, header)) continue;
        if (headersWhitelist.includes(header.toLowerCase())) {
          newHeaders[header] = entry.responseHeaders[header];
        }
      }

      const entryHeader = new TextEncoder().encode(JSON.stringify({
        url: entry.url,
        rangeStart: entry.rangeStart,
        rangeEnd: entry.rangeEnd,
        responseType: entry.responseType,
        storeRaw: entry.storeRaw,
        stats: entry.stats,
        responseURL: entry.responseURL,
        responseHeaders: newHeaders,
        dataSize,
      }));

      const entryHeaderPart = new ArrayBuffer(4 + entryHeader.byteLength);
      const entryHeaderView = new DataView(entryHeaderPart);
      entryHeaderView.setUint32(0, entryHeader.byteLength);
      new Uint8Array(entryHeaderPart, 4).set(entryHeader);

      await writer.write(new Uint8Array(entryHeaderPart));
      await writer.write(new Uint8Array(data));


      if (progressCallback) {
        progressCallback((i + 1) / entries.length);
      }
    }
  }

  /**
   * Reads a local .fsa file a chunk at a time, the next one ahead of parseFSA.
   * @param {File|Blob} file
   * @param {(share: number) => void} [progressCallback] - Called with the share of entries read.
   * @param {import('../network/DownloadManager.mjs').DownloadManager} [downloadManager] - Receives the entries' data.
   * @return {Promise<Object>} What parseFSA returns.
   */
  static async parseFSAFile(file, progressCallback, downloadManager) {
    if (!file.size) {
      throw new Error('The archive file is empty');
    }
    const chunkSize = this.fileChunkSize;
    const chunkCount = Math.ceil(file.size / chunkSize);
    const buffer = new LargeBuffer(file.size, chunkCount);
    await buffer.initialize(async (i) => {
      const start = i * chunkSize;
      return new Uint8Array(await file.slice(start, Math.min(start + chunkSize, file.size)).arrayBuffer());
    });
    return await this.parseFSA(buffer, progressCallback, downloadManager);
  }

  /**
   * @param {import('../modules/LargeBuffer.mjs').LargeBuffer} largeBuffer - The archive's bytes.
   * @param {(share: number) => void} [progressCallback] - Called with the share of entries read.
   * @param {import('../network/DownloadManager.mjs').DownloadManager} [downloadManager] - Receives the entries' data.
   */
  static async parseFSA(largeBuffer, progressCallback, downloadManager) {
    const entries = [];

    const headerSize = await largeBuffer.uint32();
    const header = JSON.parse(new TextDecoder().decode(await largeBuffer.read(headerSize)));

    for (let i = 0; i < header.number_of_entries; i++) {
      const entryHeaderSize = await largeBuffer.uint32();
      const entryHeader = JSON.parse(new TextDecoder().decode(await largeBuffer.read(entryHeaderSize)));
      const dataSize = entryHeader.dataSize;

      const entry = new DownloadEntry({
        url: entryHeader.url,
        rangeStart: entryHeader.rangeStart,
        rangeEnd: entryHeader.rangeEnd,
        responseType: entryHeader.responseType,
        storeRaw: entryHeader.storeRaw,
      });

      entry.stats = entryHeader.stats;
      entry.status = DownloadStatus.DOWNLOAD_COMPLETE;
      entry.responseURL = entryHeader.responseURL;
      entry.responseHeaders = entryHeader.responseHeaders;

      if (entry.storeRaw) {
        entry.data = await largeBuffer.read(dataSize);
        if (entry.responseType !== 'arraybuffer') {
          entry.data = new TextDecoder().decode(entry.data);
        }
      } else {
        const mimeType = entry.responseType === 'arraybuffer' ? 'application/octet-stream' : 'text/plain';
        entry.data = new Blob(await largeBuffer.getParts(dataSize), {
          type: mimeType,
        });
      }

      entry.dataSize = Utils.getDataByteSize(entry.data);

      if (downloadManager) {
        await downloadManager.archiveEntryData(entry);
      }

      entries.push(entry);
      if (progressCallback) {
        progressCallback((i + 1) / header.number_of_entries);
      }
    }

    // Maybe someone else's file: no login headers, as from a link.
    const source = header.source;
    if (source && typeof source === 'object') {
      const headers = source.headers;
      source.headers = headers && typeof headers === 'object' && !Array.isArray(headers) ? withoutCredentials(headers) : {};
    }

    return {
      source,
      currentLevel: header.currentLevel,
      currentAudioLevel: header.currentAudioLevel,
      entries,
    };
  }
}
