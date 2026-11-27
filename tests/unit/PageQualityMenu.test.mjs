import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import pageQualityControlSource from '../../chrome/page-quality-control.js?raw';
import {closerTo, menuQualities, playableSwitch, sizeClass} from '../../chrome/player/utils/PageQualityMenu.mjs';

// A page player's menu of qualities (page-quality-control.js reads it in the page) as the player's quality list.
// The clicks through real players' menus run in the e2e suites.

const context = vm.createContext({});
vm.runInContext(pageQualityControlSource, context, {filename: 'chrome/page-quality-control.js'});
const {qualityLabel} = vm.runInContext('PageQualityControl', context);

describe('page-quality-control.js, a menu entry\'s label', () => {
  it('reads the heights players write', () => {
    const heights = ['360p', '720p60', '1080p HDR', '720p (2.5 Mbps)', '1080P', '480', '2160p · HDR10', '4K', 'Full HD',
      'HD', 'SD', '1440p60 HDR']
        .map((text) => qualityLabel(text)?.height);
    expect(heights).toEqual([360, 720, 1080, 720, 1080, 480, 2160, 2160, 1080, 720, 480, 1440]);
  });

  it('knows Auto in its languages, and a bare number as bare', () => {
    expect(['Auto', 'Auto (720p)', 'Automatisch', '自动'].map((text) => qualityLabel(text)?.auto)).toEqual([true, true, true, true]);
    expect(qualityLabel('720')?.bare).toBe(true);
    expect(qualityLabel('720p')?.bare).toBe(false);
  });

  it('takes no sentence, price, year or speed for a label', () => {
    for (const text of ['Watch in 1080p now', '2024', '1080 views', '1.5x', 'Episode 720', '100', '9999p', '']) {
      expect(qualityLabel(text), text).toBeNull();
    }
  });
});

describe('PageQualityMenu', () => {
  const answer = {id: 2, choices: [
    {label: 'Auto', height: 0, auto: true, selected: false},
    {label: '360p', height: 360, auto: false, selected: false},
    {label: '480p', height: 480, auto: false, selected: false},
    {label: '1080p', height: 1080, auto: false, selected: false},
  ]};

  it('lists the files without Auto, the one playing by its size', () => {
    expect(menuQualities(answer, 'https://h.test/a.mp4', 854, 480)).toEqual([
      {url: null, label: '360p', height: 360, control: {id: 2, index: 1}},
      {url: 'https://h.test/a.mp4', label: '480p', height: 480, control: {id: 2, index: 2}},
      {url: null, label: '1080p', height: 1080, control: {id: 2, index: 3}},
    ]);
  });

  it('takes the menu\'s own mark over the size', () => {
    const marked = {...answer, choices: answer.choices.map((choice) => ({...choice, selected: choice.label === '1080p'}))};
    expect(menuQualities(marked, 'https://h.test/a.mp4', 854, 480).map((entry) => entry.url))
        .toEqual([null, null, 'https://h.test/a.mp4']);
  });

  it('names a film by its size class: 1920x800 is the 1080p one', () => {
    expect(sizeClass(1920, 800)).toBe(1080);
    expect(sizeClass(853, 480)).toBe(480);
    expect(sizeClass(1080, 1920)).toBe(1080);
    expect(menuQualities(answer, 'https://h.test/a.mp4', 1920, 800)[2].url).toBe('https://h.test/a.mp4');
  });

  it('lists nothing from one height, an answer of another shape, or before a size or a mark', () => {
    expect(menuQualities({id: 2, choices: answer.choices.slice(0, 2)}, 'https://h.test/a.mp4', 640, 360)).toBeNull();
    expect(menuQualities({choices: answer.choices}, 'https://h.test/a.mp4', 640, 360)).toBeNull();
    expect(menuQualities(null, 'https://h.test/a.mp4', 640, 360)).toBeNull();
    expect(menuQualities(answer, 'https://h.test/a.mp4', 0, 0)).toBeNull();
  });

  it('cuts a page\'s long label and drops one without text', () => {
    const odd = {id: 1, choices: [{label: 'x'.repeat(100), height: 360}, {label: '', height: 720}, {label: '1080p', height: 1080}]};
    const entries = menuQualities(odd, 'https://h.test/a.mp4', 640, 360);
    expect(entries.map((entry) => entry.label.length)).toEqual([40, 5]);
  });

  it('plays a switched file only of the played one\'s origin, over the web', () => {
    expect(playableSwitch('https://h.test/b.mp4', 'https://h.test/a.mp4')).toBe(true);
    expect(playableSwitch('https://cdn.h.test/b.mp4', 'https://h.test/a.mp4')).toBe(false);
    expect(playableSwitch('http://h.test/b.mp4', 'https://h.test/a.mp4')).toBe(false);
    expect(playableSwitch('blob:https://h.test/1', 'https://h.test/a.mp4')).toBe(false);
    expect(playableSwitch('data:video/mp4,', 'https://h.test/a.mp4')).toBe(false);
    expect(playableSwitch(undefined, 'https://h.test/a.mp4')).toBe(false);
  });

  it('switches by itself only closer to the quality wanted', () => {
    expect(closerTo(Infinity, 360, 480)).toBe(true);
    expect(closerTo(Infinity, 480, 480)).toBe(false);
    expect(closerTo(Infinity, 480, 360)).toBe(false);
    expect(closerTo(720, 1080, 720)).toBe(true);
    expect(closerTo(720, 720, 1080)).toBe(false);
    expect(closerTo(720, 480, 0)).toBe(false);
  });
});
