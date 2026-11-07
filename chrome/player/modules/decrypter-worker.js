// @ts-check

/**
 * A segment to decrypt (HLSDecrypter.decrypt), AES-128 CBC with its key and IV.
 * @typedef {{id: number, encrypted: BufferSource, iv: BufferSource, key: BufferSource}} DecryptRequest
 */

onmessage = (e) => {
  decrypt(e.data);
};

/**
 * @param {BufferSource} value
 * @return {Uint8Array<ArrayBuffer>}
 */
function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return /** @type {Uint8Array<ArrayBuffer>} */ (value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return new Uint8Array(value);
}

function getSubtle() {
  const cryptoObj = globalThis.crypto;

  if (!cryptoObj) {
    return null;
  }

  // None outside a secure context (the web build on a plain http address).
  return cryptoObj.subtle || null;
}

/** @param {DecryptRequest} data */
async function decrypt(data) {
  const subtle = getSubtle();

  if (!subtle) {
    postMessage({
      decrypted: new ArrayBuffer(0),
      id: data.id,
      error: 'WebCrypto subtle crypto is unavailable in this worker',
    });
    return;
  }

  try {
    const encrypted = toUint8Array(data.encrypted);
    const iv = toUint8Array(data.iv);
    const keyBytes = toUint8Array(data.key);

    if (iv.byteLength !== 16) {
      throw new Error(`Invalid IV length: expected 16, got ${iv.byteLength}`);
    }

    const importedKey = await subtle.importKey(
        'raw',
        keyBytes,
        {name: 'AES-CBC'},
        false,
        ['decrypt'],
    );

    const decrypted = await subtle.decrypt(
        {name: 'AES-CBC', iv},
        importedKey,
        encrypted,
    );

    postMessage({
      decrypted,
      id: data.id,
    }, [decrypted]);
  } catch (error) {
    postMessage({
      decrypted: new ArrayBuffer(0),
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
