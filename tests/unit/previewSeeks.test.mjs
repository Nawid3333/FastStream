import {describe, expect, it} from 'vitest';
import {NearPx, PreviewSeeks, SeekLostMs} from '../../chrome/player/ui/PreviewSeeks.mjs';

// A 100 s video on a 1000 px bar: 10 px a second.
const px = (a, b) => Math.abs(a - b) * 10;

/**
 * A seek that began at once, as the element's does.
 * @param {PreviewSeeks} seeks
 * @param {number} time
 * @param {number} now
 * @return {?number}
 */
function hover(seeks, time, now) {
  const sent = seeks.request(time, px, now);
  if (sent !== null) seeks.sent(true);
  return sent;
}

describe('the seek preview', () => {
  it('seeks the first place at once and shows nothing until its frame came', () => {
    const seeks = new PreviewSeeks();
    expect(hover(seeks, 40, 0)).toBe(40);
    expect(seeks.fits(px)).toBe(false);
    expect(seeks.seeked(50, 40)).toBe(null);
    expect(seeks.fits(px)).toBe(true);
  });

  it('waits for the running seek while the pointer stays near, then seeks the newest place', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    expect(hover(seeks, 40.5, 16)).toBe(null);
    expect(hover(seeks, 41, 32)).toBe(null);
    expect(seeks.seeked(60, 40)).toBe(41);
    // The frame of 40 is 10 px from 41: it shows while 41 loads.
    expect(seeks.fits(px)).toBe(true);
    expect(seeks.seeked(90, 41)).toBe(null);
  });

  it('seeks a far place at once and hides the old frame there', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    seeks.seeked(50, 40);
    expect(hover(seeks, 80, 1000)).toBe(80);
    expect(seeks.fits(px)).toBe(false);
    seeks.seeked(1100, 80);
    expect(seeks.fits(px)).toBe(true);
  });

  it('stops waiting for a seek far from the pointer, even one still running', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    expect(hover(seeks, 40 + NearPx / 10 + 1, 10)).toBe(44);
  });

  it('waits for the running seek through a sweep, and shows its frames on the way', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    seeks.seeked(50, 40);
    expect(hover(seeks, 41, 60)).toBe(41);
    for (let t = 42; t <= 46; t++) expect(hover(seeks, t, 60 + t)).toBe(null);
    // 50 px behind the pointer, but of the same movement.
    expect(seeks.fits(px)).toBe(true);
    expect(seeks.seeked(200, 41)).toBe(46);
    expect(seeks.fits(px)).toBe(true);
  });

  it('does not show the frame of a place before a jump', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    seeks.seeked(50, 40);
    hover(seeks, 41, 60);
    hover(seeks, 80, 70);
    hover(seeks, 41, 80);
    expect(seeks.fits(px)).toBe(true);
    hover(seeks, 45, 90);
    expect(seeks.fits(px)).toBe(false);
  });

  it('does not wait for a seek that never ended', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    expect(hover(seeks, 40.5, SeekLostMs - 1)).toBe(null);
    expect(hover(seeks, 40.6, SeekLostMs)).toBe(40.6);
  });

  it('does not wait for a seek the player held', () => {
    const seeks = new PreviewSeeks();
    seeks.request(40, px, 0);
    seeks.sent(false);
    expect(hover(seeks, 40.5, 10)).toBe(40.5);
  });

  it('takes the place a held seek went to for the frame on screen', () => {
    const seeks = new PreviewSeeks();
    seeks.request(40, px, 0);
    seeks.sent(false);
    expect(seeks.seeked(500, 40)).toBe(null);
    expect(seeks.fits(px)).toBe(true);
  });

  it('does not seek again to the place already on screen', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    seeks.seeked(50, 40);
    hover(seeks, 40.5, 60);
    hover(seeks, 40.6, 70);
    hover(seeks, 40.5, 80);
    expect(seeks.seeked(100, 40.5)).toBe(null);
  });

  it('seeks the pointer\'s place once the running seek has not ended for SeekLostMs', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    hover(seeks, 40.5, 10);
    expect(seeks.overdue(SeekLostMs - 1)).toBe(null);
    expect(seeks.overdue(SeekLostMs)).toBe(40.5);
    expect(seeks.overdue(2 * SeekLostMs)).toBe(null);
  });

  it('starts over for a new preview player', () => {
    const seeks = new PreviewSeeks();
    hover(seeks, 40, 0);
    seeks.seeked(50, 40);
    seeks.reset();
    expect(seeks.fits(px)).toBe(false);
    expect(hover(seeks, 40.5, 60)).toBe(40.5);
  });
});
