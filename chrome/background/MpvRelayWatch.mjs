// @ts-check

import {QueueCountProperty} from './MpvOffer.mjs';
import {cutToLength} from './MpvTarget.mjs';

/**
 * MPV autoplay's watch of mpv over the helper's `relay` port: mpv's file, its end and its episode keys; an end mpv
 * tells well before the length is no end (brokeOff).
 */

// The helper allows only user-data/faststream/...; mpv's episode buttons show while `connected` holds and the heartbeat moves.
export const ConnectedProperty = 'user-data/faststream/connected';
export const HeartbeatProperty = 'user-data/faststream/heartbeat';
export const AutoplayProperty = 'user-data/faststream/autoplay';
// The autoplay countdown's seconds: mpv-config's queue counts down as long before a queued stream.
export const CountdownProperty = 'user-data/faststream/countdown';

// mpv's setup hides the episode buttons once the heartbeat stood still for 90 s.
export const HeartbeatMs = 30000;

// An HLS stream with discontinuities can stop mpv paused at its end, eof-reached never set.
export const EndSlackSeconds = 0.5;

// A stream that breaks off ends early: mpv's HLS reader skips every segment it cannot load, straight to the end. An end
// mpv tells is one within the larger of these of the length (a length from a playlist may be off a little).
export const EofSlackSeconds = 30;
export const EofSlackShare = 0.05;

/**
 * Whether an end mpv told came where the stream broke off, not at its end: known to be well before it.
 * @param {*} remaining - mpv's time-remaining, seconds.
 * @param {*} duration - mpv's duration, seconds.
 * @return {boolean}
 */
export function brokeOff(remaining, duration) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || typeof duration !== 'number' ||
      !Number.isFinite(duration)) {
    return false;
  }
  return remaining > Math.max(EofSlackSeconds, duration * EofSlackShare);
}

// At keep-open "no" mpv quits at a file's end, and autoplay's countdown with it; mpv restores the user's value when the file goes.
const KeepOpenProperty = 'keep-open';
const FileKeepOpenProperty = 'file-local-options/keep-open';

// Also how long mpv's own text stays when this mpv has no notify.lua and the notice names no time.
export const MaxNoticeSeconds = 60;
const DefaultTextSeconds = 4;

// What the helper takes in a notice or mpv's own text (its allowlist), in UTF-16 units.
const MaxNoticeChars = 2048;

/**
 * Script messages from mpv's keys, buttons and menus; mpv gives them to every IPC client.
 * @type {Object<string, string>}
 */
export const EpisodeMessages = {
  'faststream-next': 'next',
  'faststream-previous': 'previous',
  'faststream-autoplay': 'autoplay',
  'faststream-pause': 'pause',
};

// mpv-config's faststream-offer.lua answers an offer with faststream-choice <id> <choice>.
const ChoiceMessage = 'faststream-choice';
const Choices = new Set(['here', 'queue', 'window', 'none']);

const PathId = 1;
const EofId = 2;
const PauseId = 3;
const QueueId = 4;
const DecoderBaseId = 10;

/**
 * undefined: notify.lua's own default (2 s).
 * @param {*} seconds
 * @return {number|undefined}
 */
export function noticeSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(Math.min(seconds, MaxNoticeSeconds) * 10) / 10 || undefined;
}

/**
 * One line, no `${` (mpv's own text expands a property there), at most MaxNoticeChars: the helper refuses others.
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

/** @typedef {{error: string, data?: *}} MpvReply */

/**
 * ask: mpv's replies in order; every one an error when the helper refused it, none came in time, or the watch ended.
 * command: sent without a reply.
 * @typedef {{notify: (title: string, detail?: string, seconds?: number) => void,
 *   hide: () => void, state: (state: {autoplay: boolean, countdown?: number}) => void, stop: () => void,
 *   ask: (commands: Array<Array<*>>, timeoutMs: number) => Promise<Array<MpvReply>>,
 *   command: (command: Array<*>) => void}} MpvWatcher
 */

/** @typedef {{type: 'mpv', command: Array<*>, id?: number}} MpvCommand */
/**
 * @typedef {MpvCommand|{type: 'relay', heartbeat: {property: string, everyMs: number}, onStop: Array<Array<*>>,
 *   window?: string}} ToHelperMessage
 */

/**
 * Follows mpv's file, its end and its episode keys. An end: eof-reached false -> true unless mpv stopped well before
 * the end (brokeOff), an end-file "eof", or a pause or seek in the last EndSlackSeconds.
 * @param {*} port
 * @param {(event: import('./MpvBackend.mjs').RelayEvent) => void} onEvent
 * @param {{decoderProperties?: Array<string>, window?: string}} [options] - window: the helper's id of the mpv to
 *   follow, '' for the one on its own pipe.
 * @return {MpvWatcher}
 */
export function relayWatch(port, onEvent, {decoderProperties = [], window = ''} = {}) {
  let ended = false;
  let relaying = false;
  /** @type {Array<MpvCommand>} */
  const queue = [];
  /** @type {boolean|undefined} */
  let eof;
  /** @type {?string} */
  let path = null;
  /** @type {?string} */
  let endedPath = null;
  let pauseSeen = false;
  let requests = 0;
  const endChecks = new Set();
  // eofCheck's two questions by id, each with the answers of its pair.
  /** @type {Map<number, {key: string, check: {path: string, left: number, remaining?: *, duration?: *}}>} */
  const eofChecks = new Map();
  /** @type {Object<string, *>} */
  const decoderValues = {};
  /** @type {?string} */
  let decoderTold = null;
  // One refused (no notify.lua in this mpv) is shown with mpv's own text instead.
  /** @type {Map<number, {text: string, seconds: (number|undefined)}>} */
  const notices = new Map();
  let autoplay = false;
  // The user's keep-open (undefined until mpv said it), and whether it is ours now.
  /** @type {?{user: *, asked: boolean, kept: boolean}} */
  let keepOpen = null;
  /** @type {Map<number, {user: *, asked: boolean, kept: boolean}>} */
  const keepOpenChecks = new Map();
  /** @type {Map<number, (reply: MpvReply) => void>} */
  const asked = new Map();

  /** @param {ToHelperMessage} message */
  const post = (message) => {
    try {
      port.postMessage(message);
    } catch (e) {
      // The helper went meanwhile: onDisconnect says so.
    }
  };
  /**
   * Held until the helper is connected to mpv.
   * @param {Array<*>} command
   * @param {number} [id]
   */
  const send = (command, id) => {
    if (ended) return;
    /** @type {MpvCommand} */
    const message = id === undefined ? {type: 'mpv', command} : {type: 'mpv', command, id};
    if (relaying) {
      post(message);
    } else {
      queue.push(message);
    }
  };
  /**
   * A null reason (stop()) sends no 'closed' event.
   * @param {string|null} reason
   */
  const end = (reason) => {
    if (ended) return false;
    ended = true;
    for (const answer of asked.values()) answer({error: 'the watch ended'});
    asked.clear();
    if (reason) onEvent({type: 'closed', reason});
    return true;
  };
  const fileEnded = () => {
    if (path !== null && endedPath !== path) {
      endedPath = path;
      onEvent({type: 'ended', path});
    }
  };
  const endCheck = () => {
    if (path === null || endedPath === path) return;
    const id = 1000 + ++requests;
    endChecks.add(id);
    send(['get_property', 'time-remaining'], id);
  };
  // An end mpv told: an end unless mpv's answers place it well before the end (brokeOff).
  const eofCheck = () => {
    if (path === null || endedPath === path) return;
    const check = {path, left: 2};
    for (const [key, name] of [['remaining', 'time-remaining'], ['duration', 'duration']]) {
      const id = 1000 + ++requests;
      eofChecks.set(id, {key, check});
      send(['get_property', name], id);
    }
  };
  // Keep-open "yes" while autoplay is on and the user's is "no".
  const followKeepOpen = () => {
    if (!keepOpen) return;
    if (keepOpen.user === undefined) {
      if (!autoplay || keepOpen.asked) return;
      keepOpen.asked = true;
      const id = 1000 + ++requests;
      keepOpenChecks.set(id, keepOpen);
      send(['get_property', KeepOpenProperty], id);
      return;
    }
    const keep = autoplay && (keepOpen.user === 'no' || keepOpen.user === false);
    if (keep !== keepOpen.kept) {
      keepOpen.kept = keep;
      send(['set_property', FileKeepOpenProperty, keep ? 'yes' : 'no']);
    }
  };
  /** @param {{text: string, seconds: (number|undefined)}} notice */
  const showText = (notice) => {
    // A whole number of milliseconds: the helper takes nothing else.
    send(['show-text', notice.text, Math.round((notice.seconds || DefaultTextSeconds) * 1000)]);
  };
  /**
   * error: mpv's ("success" when done), or why the helper refused it.
   * @param {*} id
   * @param {*} error
   * @param {*} data
   */
  const onReply = (id, error, data) => {
    if (asked.has(id)) {
      const answer = asked.get(id);
      asked.delete(id);
      answer?.(error === 'success' ? {error, data} : {error: typeof error === 'string' && error ? error : 'refused'});
    } else if (endChecks.has(id)) {
      endChecks.delete(id);
      if (error === 'success' && typeof data === 'number' && data <= EndSlackSeconds) fileEnded();
    } else if (eofChecks.has(id)) {
      const {key, check} = /** @type {{key: string, check: {path: string, left: number, remaining?: *, duration?: *}}} */ (eofChecks.get(id));
      eofChecks.delete(id);
      if (error === 'success') check[/** @type {'remaining'|'duration'} */ (key)] = data;
      if (--check.left === 0 && check.path === path && !brokeOff(check.remaining, check.duration)) fileEnded();
    } else if (keepOpenChecks.has(id)) {
      const file = keepOpenChecks.get(id);
      keepOpenChecks.delete(id);
      if (error === 'success' && file === keepOpen && data !== undefined) {
        file.user = data;
        followKeepOpen();
      }
    } else if (notices.has(id)) {
      const notice = notices.get(id);
      notices.delete(id);
      if (error && error !== 'success' && notice) showText(notice);
    }
  };
  /** @param {*} event */
  const onMpvLine = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.event === 'property-change' && event.name === 'path') {
      path = typeof event.data === 'string' ? event.data : null;
      keepOpen = path !== null ? {user: undefined, asked: false, kept: false} : null;
      followKeepOpen();
      if (path !== null) {
        onEvent({type: 'path', path});
      } else {
        // The next file may be the same one again, and its end is another end.
        endedPath = null;
      }
    } else if (event.event === 'property-change' && event.name === 'eof-reached') {
      if (eof === false && event.data === true) eofCheck();
      eof = typeof event.data === 'boolean' ? event.data : undefined;
    } else if (event.event === 'end-file' && event.reason === 'eof') {
      // The file is gone (keep-open "no"): nothing left to ask where it stopped.
      fileEnded();
    } else if (event.event === 'property-change' && event.name === 'pause') {
      if (pauseSeen && event.data === true) endCheck();
      pauseSeen = true;
    } else if (event.event === 'playback-restart') {
      endCheck();
    } else if (event.event === 'client-message' && Array.isArray(event.args)) {
      // Others' (FastStream's own faststream-offer comes back too) are not this watch's.
      const [name, id, choice] = event.args;
      const action = Object.hasOwn(EpisodeMessages, name) ? EpisodeMessages[name] : undefined;
      if (action) {
        onEvent({type: 'request', action});
      } else if (name === ChoiceMessage && typeof id === 'string' && id && Choices.has(choice)) {
        onEvent({type: 'choice', id, choice});
      }
    } else if (event.event === 'property-change' && event.name === QueueCountProperty) {
      // No data: no queue in this mpv, or nothing published yet.
      onEvent({type: 'queued', count: Number.isSafeInteger(event.data) && event.data > 0 ? event.data : 0});
    } else if (event.event === 'property-change' && decoderProperties.includes(event.name)) {
      // No data: unavailable (no video decoder loaded, between two files).
      decoderValues[event.name] = event.data;
      const replies = decoderProperties.map((name) =>
        decoderValues[name] === undefined ? {error: 'property unavailable'} : {error: 'success', data: decoderValues[name]});
      const told = JSON.stringify(replies);
      if (told !== decoderTold) {
        decoderTold = told;
        onEvent({type: 'decoder-replies', replies});
      }
    }
  };

  /**
   * What a field holds is tested before use: the relay only passes mpv's words on.
   * @param {{ok?: boolean, type?: string, error?: *, id?: number, reason?: string, data?: *}} message
   */
  port.onMessage.addListener((/** @type {{ok?: boolean, type?: string, error?: *, id?: number, reason?: string, data?: *}} */ message) => {
    if (ended || !message || typeof message !== 'object') return;
    if (message.ok === false) {
      end(message.error || 'the mpv host cannot watch mpv');
      return;
    }
    if (message.type === 'relaying') {
      if (relaying) return;
      relaying = true;
      post({type: 'mpv', command: ['observe_property', PathId, 'path']});
      post({type: 'mpv', command: ['observe_property', EofId, 'eof-reached']});
      post({type: 'mpv', command: ['observe_property', PauseId, 'pause']});
      // mpv-config's queue: what waits there plays before autoplay's next episode. Observed, so an end needs no question.
      post({type: 'mpv', command: ['observe_property', QueueId, QueueCountProperty]});
      decoderProperties.forEach((name, i) => post({type: 'mpv', command: ['observe_property', DecoderBaseId + i, name]}));
      // The helper clears it when this port closes (onStop).
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
    heartbeat: {property: HeartbeatProperty, everyMs: HeartbeatMs},
    // On the port's close, not mpv's: mpv runs on, and its episode buttons would send to no one.
    onStop: [['set_property', ConnectedProperty, false]],
    // Only another window's: the one on the helper's own pipe needs none.
    ...(window ? {window} : {}),
  });

  return {
    // Whole seconds 1-60: the helper refuses "6.5", and notify.lua reads "0" as "stay until hidden".
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
    // No id: an mpv without notify.lua refuses it, and there is nothing to take down.
    hide() {
      send(['script-message-to', 'notify', 'hide', 'faststream']);
    },
    state(state) {
      if (state && typeof state.autoplay === 'boolean') {
        send(['set_property', AutoplayProperty, state.autoplay]);
        autoplay = state.autoplay;
        followKeepOpen();
      }
      if (state && Number.isFinite(state.countdown)) {
        send(['set_property', CountdownProperty, state.countdown]);
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
    ask(commands, timeoutMs) {
      return Promise.all(commands.map((command) => new Promise((resolve) => {
        if (ended) {
          resolve({error: 'the watch ended'});
          return;
        }
        const id = 1000 + ++requests;
        const timer = setTimeout(() => {
          asked.delete(id);
          resolve({error: 'no reply in time'});
        }, timeoutMs);
        asked.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        send(command, id);
      })));
    },
    command(command) {
      send(command);
    },
  };
}
