import {afterEach, describe, expect, it, vi} from 'vitest';

import {ipcCommandRefusal} from '../../native-host/faststream-mpv-host.mjs';
import {MaxTitleChars, OfferSeconds, OfferWaitMs, WindowQuestions, answerOffer, endOffer, offerCommand, offerStream,
  offerText, readWindow} from '../../chrome/background/MpvOffer.mjs';

// The offer to a window that plays (mpv-config's faststream-offer.lua): what it sends passes the helper's own
// allowlist, and which answer counts.

const Texts = {hereTitle: 'Play here', hereDetail: 'B, in place of A', windowTitle: 'Play in a new window',
  windowDetail: 'it waits there paused; A plays on'};

afterEach(() => {
  vi.useRealTimers();
});

/** A window's relay: the commands it was given. */
function relay() {
  const sent = [];
  return {sent, command: (command) => sent.push(command)};
}

describe('the offer', () => {
  it('sends texts the helper takes: one line, cut, ${ as written', () => {
    expect(offerText('  Show\n- Episode\t1\u007f ')).toBe('Show - Episode 1');
    expect(offerText('a'.repeat(100), MaxTitleChars)).toBe('a'.repeat(MaxTitleChars - 1) + '…');
    expect(offerText('a'.repeat(MaxTitleChars), MaxTitleChars)).toBe('a'.repeat(MaxTitleChars));
    expect(offerText(undefined)).toBe('');
    const raw = {hereTitle: 'Play here', hereDetail: 'New\nshow ${path}', windowTitle: 'x'.repeat(3000),
      windowDetail: 'Old\u0000'};
    expect(ipcCommandRefusal(['script-message', 'faststream-offer', 'a-1', '15', ...Object.values(raw)])).not.toBeNull();
    const command = offerCommand('a-1', raw);
    expect(command.slice(0, 5)).toEqual(['script-message', 'faststream-offer', 'a-1', String(OfferSeconds), 'Play here']);
    expect(command[5]).toBe('New show ${path}');
    expect(ipcCommandRefusal(command)).toBeNull();
    expect(ipcCommandRefusal(['script-message', 'faststream-offer-cancel', 'a-1'])).toBeNull();
  });

  it('sends the queue\'s texts only where the window queues, still within what the helper takes', () => {
    const texts = {hereTitle: 'Play here', hereDetail: 'B, in place of A', windowTitle: 'Play in a new window',
      windowDetail: 'A plays on'};
    expect(offerCommand('a-2', texts).length).toBe(8);
    const command = offerCommand('a-2', {...texts, queueTitle: 'Add to\nqueue', queueDetail: 'plays after A'});
    expect(command.slice(8)).toEqual(['Add to queue', 'plays after A']);
    expect(ipcCommandRefusal(command)).toBeNull();
  });

  it('takes queue as an answer', async () => {
    const holder = {offer: null};
    const asked = offerStream(holder, relay(), {hereTitle: 'h', hereDetail: 'd', windowTitle: 'w',
      windowDetail: 'd', queueTitle: 'q', queueDetail: 'd'});
    answerOffer(holder, /** @type {*} */ (holder.offer).id, 'queue');
    expect(await asked).toBe('queue');
  });

  it('asks the window only what the helper lets it read', () => {
    for (const question of WindowQuestions) expect(ipcCommandRefusal([...question])).toBeNull();
  });

  it('reads whether the window plays, what, and whether it can offer', () => {
    const replies = (idle, eof, path, title, offer, queued) => [idle, eof, path, title, offer, queued].map((data) =>
      data === undefined ? {error: 'property unavailable'} : {error: 'success', data});
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', 1)))
        .toEqual({free: false, path: 'https://cdn.test/a.m3u8', title: 'A', offers: true, queued: null});
    // mpv-config's queue: how many wait; none published, no queue.
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', 1, 0)).queued).toBe(0);
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', 1, 3)).queued).toBe(3);
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', 1, -1)).queued).toBeNull();
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', 1, '2')).queued).toBeNull();
    expect(readWindow(replies(true, undefined, undefined, undefined, 1)).free).toBe(true);
    expect(readWindow(replies(false, true, 'https://cdn.test/a.m3u8', 'A', 1)).free).toBe(true);
    expect(readWindow(replies(false, false, undefined, undefined, 1)).free).toBe(true);
    expect(readWindow(replies(false, false, 'https://cdn.test/a.m3u8', 'A', undefined)).offers).toBe(false);
    // No answer: the relay's own errors.
    expect(readWindow(WindowQuestions.map(() => ({error: 'no reply in time'})))).toBeNull();
    expect(readWindow([])).toBeNull();
  });

  it('takes the answer to the offer up only, and none once its time is over, with the banners taken down', async () => {
    vi.useFakeTimers();
    const window = {offer: null};
    const port = relay();
    const asked = offerStream(window, port, Texts);
    const id = port.sent[0][2];
    answerOffer(window, 'other', 'here');
    answerOffer(window, id, 'elsewhere');
    await vi.advanceTimersByTimeAsync(OfferWaitMs - 1);
    expect(port.sent).toHaveLength(1);
    answerOffer(window, id, 'window');
    expect(await asked).toBe('window');
    expect(window.offer).toBeNull();

    const late = offerStream(window, port, Texts);
    const second = port.sent[1][2];
    expect(second).not.toBe(id);
    await vi.advanceTimersByTimeAsync(OfferWaitMs);
    expect(await late).toBe('none');
    expect(port.sent[2]).toEqual(['script-message', 'faststream-offer-cancel', second]);
    answerOffer(window, second, 'here');
    expect(window.offer).toBeNull();
  });

  it('answers none for an offer a newer one replaced, and closed for one whose window went', async () => {
    vi.useFakeTimers();
    const window = {offer: null};
    const port = relay();
    const first = offerStream(window, port, Texts);
    const second = offerStream(window, port, Texts);
    expect(await first).toBe('none');
    // mpv-config's own none for the one it replaced counts no more.
    answerOffer(window, port.sent[0][2], 'here');
    endOffer(window, 'closed');
    expect(await second).toBe('closed');
    await vi.advanceTimersByTimeAsync(OfferWaitMs);
    expect(port.sent.filter((c) => c[1] === 'faststream-offer-cancel')).toEqual([]);
  });
});
