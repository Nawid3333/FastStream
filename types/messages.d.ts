/**
 * Message contracts for the extension's cross-context traffic.
 *
 * FastStream runs code in four isolated contexts - the background event page,
 * the top-level content script, per-site injectors (YouTube, Instagram,
 * Bilibili, Facebook) and the player page itself - which talk exclusively
 * through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`. Those
 * boundaries erase types: every payload arrives as `any`, so a renamed field
 * or a wrong shape fails silently at runtime rather than at review time.
 *
 * These declarations describe the envelope and the messages whose payloads
 * have been read from the source. They are ambient, so no import is needed:
 * a file with `// @ts-check` gets them automatically.
 *
 * Adding a message: give it an interface below and add it to FSMessage. If
 * you are unsure of a payload, leave it out rather than guessing - an
 * inaccurate type is worse than an absent one.
 */

/** Every message is a plain object discriminated by `type`. */
interface FSMessageBase {
  type: string;
}

/** Liveness probe; the background replies with the string `'PONG'`. */
interface FSPing extends FSMessageBase {
  type: 'PING';
}

/** Broadcast when stored options change, so open players reload them. */
interface FSLoadOptions extends FSMessageBase {
  type: 'LOAD_OPTIONS';
  /** Epoch ms, forwarded to tabs as UPDATE_OPTIONS.time. */
  time?: number;
}

/** Sent to each tracked tab after LOAD_OPTIONS. */
interface FSUpdateOptions extends FSMessageBase {
  type: 'UPDATE_OPTIONS';
  time?: number;
}

/** Background tells a frame to swap the page player for FastStream. */
interface FSOpenPlayer extends FSMessageBase {
  type: 'OPEN_PLAYER';
  /** Extension URL of the player page. */
  url: string;
  /** True only for the top frame, which navigates rather than redirects. */
  noRedirect: boolean;
  frameId: number;
  /** -1 when the frame has no parent. */
  parentFrameId: number;
}

/** The player announcing it has finished loading. */
interface FSPlayerLoaded extends FSMessageBase {
  type: 'PLAYER_LOADED';
  url: string;
  /** False on faststream.online, true inside the extension. */
  isExt: boolean;
  /** Absent when the player was not opened from a parent frame. */
  parentFrameId?: number;
}

/**
 * Registers declarativeNetRequest rules that rewrite request headers.
 *
 * This is how FastStream fetches segments from CDNs that check Referer or
 * Origin. Getting the shape wrong here surfaces as HTTP 403 on playback, not
 * as an error, which is exactly the class of bug these types exist to catch.
 */
interface FSSetHeaders extends FSMessageBase {
  type: 'SET_HEADERS';
  /** Request URL the rules apply to. */
  url: string;
  commands: FSHeaderCommand[];
}

interface FSHeaderCommand {
  header: string;
  operation: 'set' | 'remove';
  value?: string;
}

/** Background asks a frame for its video element dimensions. */
interface FSGetVideoSize extends FSMessageBase {
  type: 'GET_VIDEO_SIZE';
}

/** Reply to GET_VIDEO_SIZE. */
interface FSVideoSize {
  width: number;
  height: number;
}

/**
 * Any message crossing a context boundary.
 *
 * The trailing FSMessageBase keeps the union open: MessageTypes carries 40+
 * entries and only the ones verified against the source are narrowed here.
 * Remove it once every message is described, to turn an unknown `type` into
 * a compile error.
 */
type FSMessage =
  | FSPing
  | FSLoadOptions
  | FSUpdateOptions
  | FSOpenPlayer
  | FSPlayerLoaded
  | FSSetHeaders
  | FSGetVideoSize
  | FSMessageBase;
