// @ts-check
import {CHANNEL, PEER_TIMEOUT_MS, VERSION} from '../network/PlayerPeers.mjs';

// "Stored now" on the options page: how much downloaded video FastStream holds at this moment, read only. On the
// disk: the players' session directories in OPFS `fsblob`, the kept buffers of closed tabs among them. In RAM: what
// the open players announce to each other (PlayerPeers), which is what the RAM budget counts.

export const StoredNowEveryMs = 5000;

/**
 * @param {FileSystemDirectoryHandle} root - The origin's OPFS root.
 * @return {Promise<number>} Bytes in the players' session directories; 0 with none.
 */
export async function diskBytes(root) {
  let sessions;
  try {
    sessions = await root.getDirectoryHandle('fsblob');
  } catch (e) {
    return 0;
  }
  let bytes = 0;
  for await (const session of /** @type {AsyncIterable<FileSystemHandle>} */ (/** @type {any} */ (sessions).values())) {
    if (session.kind !== 'directory') continue;
    // A player or the prune deletes files and directories meanwhile: what is gone holds nothing now.
    try {
      for await (const file of /** @type {AsyncIterable<FileSystemHandle>} */ (/** @type {any} */ (session).values())) {
        if (file.kind !== 'file') continue;
        try {
          bytes += (await /** @type {FileSystemFileHandle} */ (file).getFile()).size;
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      continue;
    }
  }
  return bytes;
}

/** The open players' RAM, as they announce it. */
export class PlayersRam {
  /**
   * @param {Object} [options]
   * @param {(name: string) => BroadcastChannel} [options.channel]
   * @param {() => number} [options.now]
   */
  constructor({channel, now} = {}) {
    this.now = now || (() => Date.now());
    /** @type {Map<string, {ramBytes: number, at: number}>} */
    this.players = new Map();
    /** @type {?BroadcastChannel} */
    this.channel = null;
    try {
      this.channel = (channel || ((name) => new BroadcastChannel(name)))(CHANNEL);
      this.channel.onmessage = (event) => this.receive(event.data);
    } catch (e) {
      this.channel = null;
    }
  }

  /** @param {*} message - A PlayerPeers announcement. */
  receive(message) {
    if (!message || message.v !== VERSION || typeof message.id !== 'string') return;
    if (message.bye) {
      this.players.delete(message.id);
      return;
    }
    const ramBytes = Number(message.ramBytes);
    this.players.set(message.id, {ramBytes: Number.isFinite(ramBytes) && ramBytes > 0 ? ramBytes : 0, at: this.now()});
  }

  /** @return {{bytes: number, players: number}} The players heard from lately, as PlayerPeers forgets them. */
  total() {
    const now = this.now();
    let bytes = 0;
    for (const [id, player] of this.players) {
      if (now - player.at > PEER_TIMEOUT_MS) {
        this.players.delete(id);
      } else {
        bytes += player.ramBytes;
      }
    }
    return {bytes, players: this.players.size};
  }

  close() {
    this.channel?.close();
    this.channel = null;
  }
}

/** Shows the line and refreshes it while the page is seen. */
export class StoredNow {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.box - Hidden until there is something to read.
   * @param {(disk: number, ram: number, players: number) => void} options.show
   * @param {() => Promise<FileSystemDirectoryHandle>} [options.root]
   * @param {PlayersRam} [options.ram]
   */
  constructor({box, show, root, ram}) {
    this.box = box;
    this.show = show;
    this.root = root || (() => navigator.storage.getDirectory());
    this.ram = ram || new PlayersRam();
    /** @type {any} */
    this.timer = null;
    this.reading = false;
  }

  /** @return {Promise<void>} */
  async refresh() {
    if (this.reading) return;
    this.reading = true;
    try {
      let disk = 0;
      try {
        disk = await diskBytes(await this.root());
      } catch (e) {
        // No OPFS here (a private window refuses it): nothing of FastStream's is on the disk then.
      }
      const {bytes, players} = this.ram.total();
      this.show(disk, bytes, players);
      this.box.hidden = false;
    } finally {
      this.reading = false;
    }
  }

  /** @param {boolean} seen - Whether the page is seen now. */
  setSeen(seen) {
    clearInterval(this.timer);
    this.timer = null;
    if (!seen) return;
    this.refresh().catch((e) => console.error('Reading the stored video failed', e));
    this.timer = setInterval(() => {
      this.refresh().catch((e) => console.error('Reading the stored video failed', e));
    }, StoredNowEveryMs);
  }
}
