import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import pageQualitiesSource from '../../chrome/page-qualities.js?raw';

// chrome/page-qualities.js, a classic content script before content.js: the qualities a page's
// own player offers as separate files. Run here on stand-ins for the document and the page's
// objects; the e2e suites run it on real players.

const context = vm.createContext({URL});
vm.runInContext(pageQualitiesSource, context, {filename: 'chrome/page-qualities.js'});
const PageQualities = vm.runInContext('PageQualities', context);

const BASE = 'https://www.incvideo1.online/embed/975054/';

/**
 * An element with attributes and children, as much as the scanner reads.
 * @param {string} tag
 * @param {Object<string, string>} [attributes]
 * @param {Array<Object>} [children]
 * @param {string} [text]
 * @return {Object}
 */
function element(tag, attributes = {}, children = [], text = '') {
  return {
    tag,
    textContent: text,
    hasAttribute: (name) => name in attributes,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    querySelectorAll: (selector) => children.filter((child) => child.tag === selector),
  };
}

/**
 * A document of videos and inline scripts.
 * @param {Array<Object>} videos
 * @param {Array<string>} [scripts] - Inline scripts' text.
 * @return {Object}
 */
function documentOf(videos, scripts = []) {
  return {
    querySelectorAll: (selector) => {
      if (selector === 'video') return videos;
      if (selector === 'script:not([src])') return scripts.map((text) => element('script', {}, [], text));
      return [];
    },
  };
}

// The fsst hoster's page (incvideo1.online), as it was on 2026-10-12: four Playerjs set-ups,
// one per kind of device, each with the same file string.
const FSST_FILE = '[360p]https://www.incvideo1.online/get_file/9/0b57/975000/975054/975054_360p.mp4/,' +
  '[720p]https://www.incvideo1.online/get_file/9/64bf/975000/975054/975054_720p.mp4/,' +
  '[1080p]https://www.incvideo1.online/get_file/9/48f1/975000/975054/975054.mp4/';
const FSST_SCRIPT = `
  if(isMobile.iOS()){
    var player = new Playerjs({ id: 'Video975054', subtitle: "",
      file:"${FSST_FILE}",
      default_quality: "360p", preroll: "//ads.example/vast or //ads2.example/vast" });
  } else {
    var player = new Playerjs({ id: 'Video975054', subtitle: "",
      file:"${FSST_FILE}",
      default_quality: "360p" });
  }`;

describe('PageQualities.find', () => {
  it('reads the fsst hoster\'s Playerjs file string, once', () => {
    const lists = PageQualities.find(documentOf([], [FSST_SCRIPT]), null, BASE);
    expect(lists).toHaveLength(1);
    expect(lists[0].map((q) => [q.label, q.height])).toEqual([['360p', 360], ['720p', 720], ['1080p', 1080]]);
    expect(lists[0][2].url).toBe('https://www.incvideo1.online/get_file/9/48f1/975000/975054/975054.mp4/');
  });

  it('reads a <source> list by the attribute each player uses', () => {
    const plyr = element('video', {}, [
      element('source', {src: '/v-576.mp4', size: '576'}), element('source', {src: '/v-1080.mp4', size: '1080'})]);
    const videojs = element('video', {}, [
      element('source', {src: 'https://cdn.example/a.mp4', label: 'SD', res: '480'}),
      element('source', {src: 'https://cdn.example/b.mp4', label: 'HD', res: '720'})]);
    const fluid = element('video', {}, [
      element('source', {src: 'low.mp4', title: '360p'}), element('source', {src: 'high.mp4', title: '1080p'})]);
    const lists = PageQualities.find(documentOf([plyr, videojs, fluid]), null, 'https://site.example/watch/1');
    expect(lists.map((list) => list.map((q) => `${q.label}=${q.height} ${q.url}`))).toEqual([
      ['576p=576 https://site.example/v-576.mp4', '1080p=1080 https://site.example/v-1080.mp4'],
      ['SD=480 https://cdn.example/a.mp4', 'HD=720 https://cdn.example/b.mp4'],
      ['360p=360 https://site.example/watch/low.mp4', '1080p=1080 https://site.example/watch/high.mp4'],
    ]);
  });

  it('takes no list from a video with one source, or sources without a quality', () => {
    const one = element('video', {}, [element('source', {src: 'a.mp4', label: '720p'})]);
    const formats = element('video', {}, [
      element('source', {src: 'a.webm', type: 'video/webm'}), element('source', {src: 'a.mp4', type: 'video/mp4'})]);
    expect(PageQualities.find(documentOf([one, formats]), null, BASE)).toEqual([]);
  });

  it('reads Artplayer\'s instances, JW Player\'s playlist item and a DPlayer in a page variable', () => {
    const page = {
      Artplayer: {instances: [{option: {quality: [
        {html: '<b>1080P</b>', url: 'https://a.example/1080.mp4', default: true}, {html: '720P', url: 'https://a.example/720.mp4'}]}}]},
      jwplayer: () => ({getPlaylistItem: () => ({sources: [
        {file: 'https://j.example/v_480.mp4', label: '480p'}, {file: 'https://j.example/v_720.mp4', label: '720p'}]})}),
      dp: {options: {video: {quality: [{name: 'HD', url: 'https://d.example/hd.mp4'}, {name: 'SD', url: 'https://d.example/sd.mp4'}]}}},
    };
    const lists = PageQualities.find(documentOf([]), page, BASE);
    expect(lists.map((list) => list.map((q) => `${q.label}=${q.height}`))).toEqual([
      ['1080P=1080', '720P=720'], ['480p=480', '720p=720'], ['HD=720', 'SD=480']]);
  });

  it('leaves no tag in a label, however it is nested', () => {
    const page = {Artplayer: {instances: [{option: {quality: [
      {html: '<scr<b>ipt>720p', url: 'https://a.example/720.mp4'}, {html: '1080<i>p</i>', url: 'https://a.example/1080.mp4'}]}}]}};
    const [list] = PageQualities.find(documentOf([]), page, BASE);
    expect(list.map((q) => q.label)).toEqual(['720p', '1080p']);
    expect(list.some((q) => /[<>]/.test(q.label))).toBe(false);
  });

  it('survives page objects that throw or are not what they seem', () => {
    const page = {
      get Artplayer() {
        throw new Error('dead object');
      },
      jwplayer: () => {
        throw new Error('not set up');
      },
      player: {options: 'not an object'},
    };
    expect(PageQualities.find(documentOf([]), page, BASE)).toEqual([]);
  });

  it('keeps only http(s) files, each once, and no list of more than 12', () => {
    const many = Array.from({length: 13}, (_, i) => `[${200 + i * 10}p]https://x.example/${i}.mp4`).join(',');
    const script = `file:"[360p]https://x.example/a.mp4,[360p]https://x.example/a.mp4,[720p]javascript:alert(1)";
      other = {file:"${many}"};`;
    expect(PageQualities.find(documentOf([], [script]), null, BASE)).toEqual([]);
  });
});

describe('PageQualities.parsePlayerjsFile', () => {
  it('takes the first of an entry\'s backups, and escaped slashes from JSON', () => {
    const list = PageQualities.parsePlayerjsFile('[480p]https://a.example/480.mp4 or https://b.example/480.mp4,' +
      '[720p]https://a.example/720.mp4', BASE);
    expect(list.map((q) => q.url)).toEqual(['https://a.example/480.mp4', 'https://a.example/720.mp4']);
    const doc = documentOf([], ['var o = {"file":"[480p]https:\\/\\/a.example\\/480.mp4,[720p]https:\\/\\/a.example\\/720.mp4"};']);
    expect(PageQualities.find(doc, null, BASE)[0].map((q) => q.url))
        .toEqual(['https://a.example/480.mp4', 'https://a.example/720.mp4']);
  });

  it('does not read an encoded file string', () => {
    expect(PageQualities.parsePlayerjsFile('#2aHR0cHM6Ly9hLmV4YW1wbGUvNzIwLm1wNA==', BASE)).toBe(null);
  });
});

describe('PageQualities.heightOf', () => {
  it('reads the labels players use', () => {
    const cases = {'1080p': 1080, '720': 720, 'HD 720p': 720, '1080P60': 1080, 'Full HD': 1080, 'FHD': 1080, '4K': 2160,
      'UHD': 2160, 'HD': 720, 'SD': 480, '2160p': 2160, 'Original': 0, '': 0, 'Episode 12345': 0};
    for (const [label, height] of Object.entries(cases)) {
      expect([label, PageQualities.heightOf(label)]).toEqual([label, height]);
    }
  });
});
