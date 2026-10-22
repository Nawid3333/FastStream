// @ts-check

onmessage = (e) => {
  decrypt(e.data);
};

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
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

  return cryptoObj.subtle || cryptoObj.webkitSubtle || null;
}

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
