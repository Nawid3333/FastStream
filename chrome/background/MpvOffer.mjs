// @ts-check

import {cutToLength} from './MpvTarget.mjs';

/**
 * A stream for an mpv window that plays: mpv-config's faststream-offer.lua shows the banners "Play here", "Add to
 * queue" (where mpv-config's queue runs) and "Play in a new window", and answers with the one clicked
 * (docs/notes/mpv.md "The offer", "The queue").
 */

export const OfferSeconds = 15;
// The banners' time and a little more: a click in their last moment still counts.
export const OfferWaitMs = 17000;
// How long the window may take to say what it does.
export const WindowAskMs = 2000;
// mpv-config sets it while faststream-offer.lua runs.
export const OfferProperty = 'user-data/faststream/offer';
// mpv-config's queue (Scripts/queue/) publishes how many wait behind what plays; absent, there is no queue.
export const QueueCountProperty = 'user-data/faststream/queue/count';
// A title in a banner: two of them share one line.
export const MaxTitleChars = 60;
// The helper's limit for a script-message's text.
const MaxTextChars = 2048;

/** @typedef {'here'|'queue'|'window'|'none'|'closed'} OfferChoice */
/** @typedef {{id: string, settle: (choice: OfferChoice) => void}} PendingOffer */
/** @typedef {{offer: ?PendingOffer}} OfferHolder */
/**
 * queueTitle and queueDetail only where the window queues: the third banner.
 * @typedef {{hereTitle: string, hereDetail: string, windowTitle: string, windowDetail: string, queueTitle?: string,
 *   queueDetail?: string}} OfferTexts
 */

export const WindowQuestions = Object.freeze([
  ['get_property', 'idle-active'],
  ['get_property', 'eof-reached'],
  ['get_property', 'path'],
  ['get_property', 'media-title'],
  ['get_property', OfferProperty],
  ['get_property', QueueCountProperty],
]);

/**
 * What the window's replies to WindowQuestions say; null when it did not answer (mpv always has idle-active).
 * free: nothing to lose there, idle or at its end. queued: how many wait in its queue, null without a queue.
 * @param {Array<{error: string, data?: *}>} replies
 * @return {?{free: boolean, path: ?string, title: string, offers: boolean, queued: ?number}}
 */
export function readWindow(replies) {
  if (!Array.isArray(replies) || replies.length !== WindowQuestions.length || replies[0]?.error !== 'success') {
    return null;
  }
  /** @param {number} i */
  const value = (i) => replies[i]?.error === 'success' ? replies[i].data : undefined;
  const path = typeof value(2) === 'string' && value(2) ? value(2) : null;
  return {
    free: value(0) === true || value(1) === true || path === null,
    path,
    title: typeof value(3) === 'string' ? value(3) : '',
    offers: value(4) === 1 || value(4) === true,
    queued: Number.isSafeInteger(value(5)) && value(5) >= 0 ? value(5) : null,
  };
}

/**
 * One line, as the helper takes it (no control characters), cut to max with an ellipsis.
 * @param {*} text
 * @param {number} [max]
 * @return {string}
 */
export function offerText(text, max = MaxTextChars) {
  const line = Array.from(String(text ?? ''), (c) => {
    const code = c.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : c;
  }).join('').trim();
  return line.length <= max ? line : cutToLength(line, max - 1) + '…';
}

/**
 * @param {string} id
 * @param {OfferTexts} texts
 * @return {Array<string>}
 */
export function offerCommand(id, texts) {
  const command = ['script-message', 'faststream-offer', id, String(OfferSeconds), offerText(texts.hereTitle),
    offerText(texts.hereDetail), offerText(texts.windowTitle), offerText(texts.windowDetail)];
  if (texts.queueTitle !== undefined) {
    command.push(offerText(texts.queueTitle), offerText(texts.queueDetail));
  }
  return command;
}

// This background's: an answer to an offer of one before it never matches.
const Run = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
let offers = 0;

/**
 * Shows the offer in the window and waits for its answer: none once the wait is over (the banners are taken down) or a
 * newer offer replaced it; closed when the window went (endOffer).
 * @param {OfferHolder} holder - The window's state.
 * @param {{command: (command: Array<*>) => void}} watcher - The window's relay.
 * @param {OfferTexts} texts
 * @return {Promise<OfferChoice>}
 */
export function offerStream(holder, watcher, texts) {
  endOffer(holder, 'none');
  const id = `${Run}-${++offers}`;
  return new Promise((resolve) => {
    /** @type {PendingOffer} */
    const pending = {
      id,
      settle: (choice) => {
        clearTimeout(timer);
        if (holder.offer === pending) holder.offer = null;
        resolve(choice);
      },
    };
    const timer = setTimeout(() => {
      watcher.command(['script-message', 'faststream-offer-cancel', id]);
      pending.settle('none');
    }, OfferWaitMs);
    holder.offer = pending;
    watcher.command(offerCommand(id, texts));
  });
}

/**
 * mpv's answer: only to the offer up, whose id it names.
 * @param {OfferHolder} holder
 * @param {string} id
 * @param {string} choice
 */
export function answerOffer(holder, id, choice) {
  if (holder.offer?.id === id && (choice === 'here' || choice === 'queue' || choice === 'window' || choice === 'none')) {
    holder.offer.settle(choice);
  }
}

/**
 * @param {OfferHolder} holder
 * @param {OfferChoice} choice
 */
export function endOffer(holder, choice) {
  holder.offer?.settle(choice);
}
