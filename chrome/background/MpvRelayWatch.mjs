// @ts-check

import {cutToLength} from './MpvTarget.mjs';

/**
 * MPV autoplay's watch of mpv over the thin helper's `relay` port (host 15).
 *
 * Until host 14 the helper followed mpv itself (watchMpv in native-host/faststream-mpv-host.mjs)
 * and told the extension only the outcome: a file's end, a key for the next episode. Every
 * refinement of what counts as an end (host 14's pause at the end, measured on 2026-10-13)
 * was a new helper, installed by hand. The owner chose (2026-10-13) a thin helper that only
 * passes mpv's lines on and writes the allowlisted commands sent to it; the policy is here
 * now and updates with the extension. This is watchMpv's logic, line for line, over that port:
 * MpvBackend.watch() hands its events on unchanged, so background.mjs did not change.
 *
 * mpv's JSON IPC, as measured with the pinned mpv (headless, keep-open): observe_property
 * sends the current value at once; at a file's end eof-reached goes false -> true; a loadfile
 * replace sends end-file "stop", eof-reached and path unavailable, the new path, then
 * eof-reached false; "script-message faststream-next" arrives as a client-message.
 */

// The properties of mpv's setup that FastStream writes (the helper allows only
// user-data/faststream/...). connected: mpv's episode buttons show while it holds;
// heartbeat: and while it keeps changing (the helper writes it); autoplay: what the
// autoplay button shows.
export const ConnectedProperty = 'user-data/faststream/connected';
export const HeartbeatProperty = 'user-data/faststream/heartbeat';
export const AutoplayProperty = 'user-data/faststream/autoplay';

// How often the helper writes the heartbeat: mpv's setup hides the episode buttons once it
// stood still for 90 s (three beats missed), as after a helper killed hard (host 10).
export const HeartbeatMs = 30000;

// How close to its end mpv may stop, paused or after a seek, and it is the end (host 14: a
// skip past the end of an HLS stream with discontinuities stopped mpv there, paused, with
// eof-reached never set).
export const EndSlackSeconds = 0.5;

// The longest a notice stays in mpv, and how long mpv's own text stays when this mpv has no
// notify.lua and the notice names no time.
export const MaxNoticeSeconds = 60;
const DefaultTextSeconds = 4;

// What the helper takes in a notice or mpv's own text (its allowlist), in UTF-16 units.
const MaxNoticeChars = 2048;

/**
 * The script messages an mpv key, button or menu sends for the next or the previous episode
 * (input.conf: "n script-message faststream-next"), and for autoplay on or off (the mpv
 * setup's autoplay button); mpv gives them to every IPC client.
 * @type {Object<string, string>}
 */
export const EpisodeMessages = {
  'faststream-next': 'next',
  'faststream-previous': 'previous',
  'faststream-autoplay': 'autoplay',
};

// The ids of the observed properties.
const PathId = 1;
const EofId = 2;
const PauseId = 3;

/**
 * How long a notice asks to stay: seconds between 0 (exclusive) and MaxNoticeSeconds, to a
 * tenth; undefined for anything else (notify.lua's own default then, 2 s).
 * @param {*} seconds - What the background asked for.
 * @return {number|undefined}
 */
export function noticeSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(Math.min(seconds, MaxNoticeSeconds) * 10) / 10 || undefined;
}

/**
 * A notice's text as the helper takes it: one line, no `${` (mpv's own text would expand a
 * property there), at most MaxNoticeChars. The background's notices are its own sentences,
 * but one the helper refused would not show at all.
 * @param {*} text
 * @return {string}
 */
function noticeText(text) {
  const oneLine = Array.from(String(text), (c) => {
    const code = c.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : c;
  }).join('').split('${').join('$ {');
  return cutToLength(oneLine, MaxNoticeChars);
}

/**
 * @typedef {{notify: (title: string, detail?: string, seconds?: number) => void,
 *   hide: () => void, state: (state: Object) => void, stop: () => void}} MpvWatcher
 */

/**
 * Follows mpv over a `relay` port of the helper: its file, its end, and its keys for the next
 * or the previous episode, each sent as it happens as watchMpv sent them (host 7's watch):
 * {type: 'watching'} once mpv is followed, {type: 'path', path}, {type: 'ended', path},
 * {type: 'request', action}, and {type: 'closed', reason} last (not after stop()).
 *
 * An end is eof-reached going from false to true for the file mpv has (keep-open stops at the
 * end), or an end-file "eof" (an mpv without keep-open), or mpv in the last EndSlackSeconds of
 * its file when it pauses there or a seek lands there (playback-restart; host 14). The first
 * eof-reached and pause values are mpv's state when the watch began, not events: a file that
 * ended before is no end now. One end per file: the same path again (a loadfile replace of the
 * same episode) is a new file once mpv said it had none in between.
 *
 * @param {*} port - A connectNative port to the helper (postMessage, onMessage, onDisconnect,
 *   disconnect), nothing sent on it yet.
 * @param {(event: Object) => void} onEvent - Gets each event.
 * @param {{onLegacy?: () => void}} [options] - onLegacy: the helper answered "unknown
 *   message", one from before host 15. The watch then ends without a 'closed' event, for the
 *   caller to follow mpv the old way.
 * @return {MpvWatcher}
 */
export function relayWatch(port, onEvent, {onLegacy} = {}) {
  let ended = false;
  let relaying = false;
  /** @type {Array<Object>} */
  const queue = [];
  /** @type {boolean|undefined} */
  let eof;
  /** @type {?string} */
  let path = null;
  /** @type {?string} */
  let endedPath = null;
  let pauseSeen = false;
  let requests = 0;
  // The questions for the time left (endCheck), by id.
  const endChecks = new Set();
  // A notice sent to notify.lua, by id: one refused (no notify.lua in this mpv's config) is
  // shown with mpv's own text instead.
  /** @type {Map<number, {text: string, seconds: (number|undefined)}>} */
  const notices = new Map();

  const post = (message) => {
    try {
      port.postMessage(message);
    } catch (e) {
      // The helper went meanwhile: onDisconnect says so.
    }
  };
  /**
   * One mpv command through the helper; with an id, its answer comes back as mpv-reply.
   * Held until the helper is connected to mpv (relaying).
   * @param {Array<*>} command
   * @param {number} [id]
   */
  const send = (command, id) => {
    if (ended) return;
    const message = id === undefined ? {type: 'mpv', command} : {type: 'mpv', command, id};
    if (relaying) {
      post(message);
    } else {
      queue.push(message);
    }
  };
  const end = (reason) => {
    if (ended) return false;
    ended = true;
    if (reason) onEvent({type: 'closed', reason});
    return true;
  };
  const fileEnded = () => {
    if (path !== null && endedPath !== path) {
      endedPath = path;
      onEvent({type: 'ended', path});
    }
  };
  // Asks mpv how much of its file is left: the answer may be an end (host 14).
  const endCheck = () => {
    if (path === null || endedPath === path) return;
    const id = 1000 + ++requests;
    endChecks.add(id);
    send(['get_property', 'time-remaining'], id);
  };
  /**
   * mpv's own text in place of a notice notify.lua did not show.
   * @param {{text: string, seconds: (number|undefined)}} notice
   */
  const showText = (notice) => {
    // A whole number of milliseconds: the helper takes nothing else.
    send(['show-text', notice.text, Math.round((notice.seconds || DefaultTextSeconds) * 1000)]);
  };
  /**
   * The helper's answer to a command of ours that had an id.
   * @param {*} id
   * @param {*} error - mpv's ("success" when it did it), or why the helper refused it.
   * @param {*} data
   */
  const onReply = (id, error, data) => {
    if (endChecks.has(id)) {
      endChecks.delete(id);
      if (error === 'success' && typeof data === 'number' && data <= EndSlackSeconds) fileEnded();
    } else if (notices.has(id)) {
      const notice = notices.get(id);
      notices.delete(id);
      if (error && error !== 'success' && notice) showText(notice);
    }
  };
  /**
   * A line mpv sent (an event).
   * @param {*} event
   */
  const onMpvLine = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.event === 'property-change' && event.name === 'path') {
      path = typeof event.data === 'string' ? event.data : null;
      if (path !== null) {
        onEvent({type: 'path', path});
      } else {
        // Between two files (a loadfile replace): the next may be the same one again, and its
        // end is another end (seen with the pinned mpv).
        endedPath = null;
      }
    } else if (event.event === 'property-change' && event.name === 'eof-reached') {
      if (eof === false && event.data === true) fileEnded();
      eof = typeof event.data === 'boolean' ? event.data : undefined;
    } else if (event.event === 'end-file' && event.reason === 'eof') {
      fileEnded();
    } else if (event.event === 'property-change' && event.name === 'pause') {
      if (pauseSeen && event.data === true) endCheck();
      pauseSeen = true;
    } else if (event.event === 'playback-restart') {
      endCheck();
    } else if (event.event === 'client-message' && Array.isArray(event.args)) {
      const action = Object.hasOwn(EpisodeMessages, event.args[0]) ? EpisodeMessages[event.args[0]] : undefined;
      if (action) onEvent({type: 'request', action});
    }
  };

  port.onMessage.addListener((message) => {
    if (ended || !message || typeof message !== 'object') return;
    if (message.ok === false) {
      if (message.error === 'unknown message' && !Array.isArray(message.capabilities) && onLegacy) {
        // A helper from before host 15: it exits after this answer.
        ended = true;
        try {
          port.disconnect();
        } catch (e) {
          // Gone already.
        }
        onLegacy();
        return;
      }
      end(message.error || 'the mpv host cannot watch mpv');
      return;
    }
    if (message.type === 'relaying') {
      if (relaying) return;
      relaying = true;
      post({type: 'mpv', command: ['observe_property', PathId, 'path']});
      post({type: 'mpv', command: ['observe_property', EofId, 'eof-reached']});
      post({type: 'mpv', command: ['observe_property', PauseId, 'pause']});
      // mpv's episode buttons show while this holds (host 9); the helper clears it when this
      // port closes (onStop below).
      post({type: 'mpv', command: ['set_property', ConnectedProperty, true]});
      for (const queued of queue.splice(0)) post(queued);
      onEvent({type: 'watching'});
    } else if (message.type === 'mpv') {
      onMpvLine(message.data);
    } else if (message.type === 'mpv-reply') {
      onReply(message.id, message.error, message.data);
    } else if (message.type === 'mpv-refused') {
      onReply(message.id, message.reason || 'refused', undefined);
    } else if (message.type === 'closed') {
      // A relay message the helper refused comes back as reason 'refused' with its error.
      const reason = message.reason || 'closed';
      end(typeof message.error === 'string' && message.error ? `${reason} (${message.error})` : reason);
    }
  });
  port.onDisconnect.addListener(() => {
    end(globalThis.chrome?.runtime?.lastError?.message || 'the mpv host went');
  });
  post({
    type: 'relay',
    // The helper writes it at once and then every 30 s, while this port is open.
    heartbeat: {property: HeartbeatProperty, everyMs: HeartbeatMs},
    // Written when the extension lets go (the port closes), not when mpv goes: mpv runs on,
    // and its episode buttons would send to no one.
    onStop: [['set_property', ConnectedProperty, false]],
  });

  return {
    // seconds: how long mpv shows it (notify.lua's own 2 s without), whole seconds from 1 to
    // 60: the helper refuses "6.5", and "0" (notify.lua reads 0 as "stay until hidden").
    // Left out when none was given.
    notify(title, detail = '', seconds) {
      if (ended) return;
      const id = 1000 + ++requests;
      const time = noticeSeconds(seconds);
      const whole = time === undefined ? undefined : Math.min(MaxNoticeSeconds, Math.max(1, Math.round(time)));
      const titleText = noticeText(title);
      const detailText = noticeText(detail);
      notices.set(id, {text: noticeText(detail ? String(title) + ': ' + String(detail) : String(title)), seconds: whole});
      const command = ['script-message-to', 'notify', 'show', 'faststream', titleText, detailText];
      if (whole !== undefined) command.push(String(whole));
      send(command, id);
    },
    // Takes the notice down before its time. No id: an mpv without notify.lua refuses it,
    // and there is nothing to take down.
    hide() {
      send(['script-message-to', 'notify', 'hide', 'faststream']);
    },
    // What mpv's autoplay button shows: {autoplay: boolean}, nothing else.
    state(state) {
      if (state && typeof state.autoplay === 'boolean') {
        send(['set_property', AutoplayProperty, state.autoplay]);
      }
    },
    stop() {
      if (!end(null)) return;
      try {
        port.disconnect();
      } catch (e) {
        // Gone already.
      }
    },
  };
}
