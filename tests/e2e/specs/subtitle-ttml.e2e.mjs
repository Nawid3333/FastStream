// TTML and DFXP subtitles, read by Firefox's own XML parser into the player's cues: the
// document walk TtmlSubtitles.test.mjs cannot run without a DOM.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

const IMSC = `<?xml version="1.0" encoding="UTF-8"?>
<!-- an IMSC text profile document -->
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en" ttp:timeBase="media">
  <head>
    <styling>
      <style xml:id="base" tts:color="white"/>
      <style xml:id="em" style="base" tts:fontStyle="italic"/>
    </styling>
  </head>
  <body style="base">
    <div begin="10s">
      <p begin="00:00:01.000" end="00:00:02.500">Hello,
        <br/>   world</p>
      <p begin="00:00:03.000" end="00:00:04.000"><span style="em">Whispers</span> and <span tts:fontWeight="bold">shouts</span></p>
      <p begin="5s" dur="1.5s">A &lt; B &amp; C --&gt; D</p>
    </div>
    <div begin="00:00:30.000" end="00:00:31.000">
      <p begin="0s" end="5s">cut at its div's end</p>
      <p begin="2s" end="3s">after its div: never shown</p>
    </div>
  </body>
</tt>`;

const DFXP = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/2006/10/ttaf1" xmlns:ttp="http://www.w3.org/2006/10/ttaf1#parameter"
    xmlns:tts="http://www.w3.org/2006/10/ttaf1#styling" ttp:tickRate="10000000">
  <body><div>
    <p begin="15000000t" end="25000000t">Ticks</p>
    <p begin="30000000t">Open<span tts:fontStyle="italic"> end</span></p>
    <p begin="45000000t" end="50000000t">Next</p>
    <p begin="60000000t">Last open</p>
  </div></body>
</tt>`;

const EBU = `<?xml version="1.0"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    ttp:timeBase="smpte" ttp:frameRate="25">
  <tt:body><tt:div>
    <tt:p begin="00:00:01:12" end="00:00:02:00"><tt:span>Frames</tt:span></tt:p>
  </tt:div></tt:body>
</tt:tt>`;

const TIMING = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body>
  <div timeContainer="seq">
    <p dur="2s">A</p>
    <p dur="2s">B</p>
    <p begin="1s" dur="1s">C</p>
  </div>
  <div begin="20s">
    <p begin="1s" end="10s" dur="2s">the earlier end</p>
    <p begin="5s" end="6s" tts:fontStyle="italic"><br/>after a break</p>
    <p begin="7s" end="8s" tts:fontStyle="italic">slanted <span tts:fontStyle="normal">upright</span></p>
  </div>
</body></tt>`;

// Styles by reference, through a region, inherited down the tree, and colours the player has.
const STYLES = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
  <head>
    <styling>
      <style xml:id="speaker" tts:color="#FFFF00"/>
      <style xml:id="loud" style="speaker" tts:fontWeight="bold" tts:textDecoration="underline"/>
    </styling>
    <layout>
      <region xml:id="top" tts:origin="10% 10%" tts:extent="80% 20%" tts:textAlign="center" tts:fontStyle="italic"/>
      <region xml:id="bottom"><style tts:color="cyan"/></region>
      <region xml:id="plain" tts:color="white" tts:fontStyle="normal"/>
      <region xml:id="own" tts:color="yellow"><style tts:color="red"/></region>
    </layout>
  </head>
  <body>
    <div style="speaker">
      <p begin="1s" end="2s">yellow from its div <span tts:color="white">and white</span></p>
      <p begin="3s" end="4s" style="loud">yellow, bold, underlined</p>
      <p begin="5s" end="6s" region="top">slanted by its region</p>
      <p begin="7s" end="8s" region="bottom">yellow over its region <span tts:color="lime">lime</span> <span tts:color="#123456">no class</span></p>
      <p begin="9s" end="10s" tts:color="rgba(255,0,0,255)">red <span tts:color="banana">still red</span></p>
    </div>
    <div tts:fontStyle="italic" region="plain">
      <p begin="11s" end="12s" tts:color="yellow">a region fills only what is left open</p>
    </div>
    <div region="bottom">
      <p begin="13s" end="14s">cyan by the region its div names</p>
      <p begin="15s" end="16s" region="own">a region's own colour over its nested style</p>
    </div>
  </body>
</tt>`;

// Spans with times of their own: the p shows a word at a time.
const ROLL = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
  <p begin="10s" end="14s"><span begin="0s">one</span> <span begin="1s">two</span> <span begin="2s" end="3s">three</span></p>
  <p begin="20s" end="22s" timeContainer="seq"><span dur="1s">first</span><span dur="1s">second</span></p>
</div></body></tt>`;

/**
 * The cues SubtitleTrack.loadText reads from this text, in the player page.
 * @param {string} text
 * @return {Promise<Array<{start: number, end: number, text: string}>|string>} An error's message instead.
 */
const cuesOf = (text) => browser.execute((text) => new Promise((done) => {
  import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
    const track = new SubtitleTrack('t', 'en');
    track.loadText(text);
    done(track.cues.map((cue) => ({start: Math.round(cue.startTime * 1000) / 1000,
      end: Math.round(cue.endTime * 1000) / 1000, text: cue.text})));
  }).catch((e) => done(String(e)));
}), text);

/**
 * @param {string} name
 * @param {string} text
 * @return {Promise<{label: string, cues: number}|string>} The track the file chooser added, or why none.
 */
const addFile = (name, text) => browser.execute((name, text) => new Promise((done) => {
  const chooser = Array.from(document.querySelectorAll('input[type="file"]')).find((input) => input.accept.includes('.ttml'));
  if (!chooser) return done('no chooser takes .ttml');
  const transfer = new DataTransfer();
  transfer.items.add(new File([text], name));
  chooser.files = transfer.files;
  chooser.dispatchEvent(new Event('change'));
  const subtitles = window.fastStream.interfaceController.subtitlesManager;
  const started = Date.now();
  const wait = () => {
    const track = subtitles.tracks.find((t) => t.label === name);
    if (track) return done({label: track.label, cues: track.cues.length});
    if (Date.now() - started > 3000) return done('never added');
    setTimeout(wait, 50);
  };
  wait();
}), name, text);

describe('TTML and DFXP subtitles', function() {
  before(async function() {
    await browser.url(`/player/index.html?t=${Date.now()}`);
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
        {timeout: 30000, timeoutMsg: 'the player never started'});
  });

  it('reads TTML: nested times, line breaks, styles by reference, escaped text', async function() {
    expect(await cuesOf(IMSC)).toEqual([
      {start: 11, end: 12.5, text: 'Hello,\nworld'},
      {start: 13, end: 14, text: '<i>Whispers</i> and <b>shouts</b>'},
      {start: 15, end: 16.5, text: 'A &lt; B &amp; C --&gt; D'},
      {start: 30, end: 31, text: 'cut at its div\'s end'},
    ]);
  });

  it('reads DFXP in ticks, and ends an open cue at the next one', async function() {
    expect(await cuesOf(DFXP)).toEqual([
      {start: 1.5, end: 2.5, text: 'Ticks'},
      {start: 3, end: 4.5, text: 'Open<i> end</i>'},
      {start: 4.5, end: 5, text: 'Next'},
      {start: 6, end: 8, text: 'Last open'},
    ]);
  });

  it('places a seq container\'s children one after another, takes the earlier of end and dur, and styles each run', async function() {
    expect(await cuesOf(TIMING)).toEqual([
      {start: 0, end: 2, text: 'A'},
      {start: 2, end: 4, text: 'B'},
      {start: 5, end: 6, text: 'C'},
      {start: 21, end: 23, text: 'the earlier end'},
      {start: 25, end: 26, text: '<i>after a break</i>'},
      {start: 27, end: 28, text: '<i>slanted </i>upright'},
    ]);
  });

  it('reads a prefixed EBU-TT document in frames, and a frame rate with its multiplier', async function() {
    expect(await cuesOf(EBU)).toEqual([{start: 1.48, end: 2, text: 'Frames'}]);
    // 29.97 frames a second: frame 15 is 0.5005 s in, frame 360 12.012 s.
    const ntsc = await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
        ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001"><body>
      <p begin="00:00:10:15" end="360f">NTSC</p></body></tt>`);
    expect(ntsc).toHaveLength(1);
    expect(ntsc[0].start).toBeCloseTo(10.5005, 2);
    expect(ntsc[0].end).toBeCloseTo(12.012, 2);
  });

  it('reads the older DFXP namespaces and a document with none', async function() {
    for (const namespace of ['http://www.w3.org/2006/04/ttaf1', 'http://www.w3.org/2006/10/ttaf1', 'http://www.w3.org/ns/ttml', '']) {
      const xmlns = namespace ? ` xmlns="${namespace}"` : '';
      expect(await cuesOf(`<tt${xmlns}><body><div><p begin="1s" end="2s">ns</p></div></body></tt>`))
          .toEqual([{start: 1, end: 2, text: 'ns'}]);
    }
  });

  it('carries colours the player has, region styles and inherited styles into the cue', async function() {
    expect(await cuesOf(STYLES)).toEqual([
      {start: 1, end: 2, text: '<c.yellow>yellow from its div </c>and white'},
      {start: 3, end: 4, text: '<c.yellow><b><u>yellow, bold, underlined</u></b></c>'},
      // The region's italic over the div's yellow.
      {start: 5, end: 6, text: '<c.yellow><i>slanted by its region</i></c>'},
      // Its div's yellow is specified: the region's cyan fills nothing.
      {start: 7, end: 8, text: '<c.yellow>yellow over its region </c><c.lime>lime</c> no class'},
      {start: 9, end: 10, text: '<c.red>red </c><c.red>still red</c>'},
      {start: 11, end: 12, text: '<c.yellow><i>a region fills only what is left open</i></c>'},
      {start: 13, end: 14, text: '<c.cyan>cyan by the region its div names</c>'},
      {start: 15, end: 16, text: '<c.yellow>a region\'s own colour over its nested style</c>'},
    ]);
  });

  it('keeps line feeds where xml:space is "preserve", and collapses them elsewhere', async function() {
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="1s" end="2s" xml:space="preserve">first line
second line</p>
      <p begin="3s" end="4s">one
        line</p>
      <p begin="5s" end="6s" xml:space="preserve"><span xml:space="default">collapsed
here</span> kept
then</p>
    </div></body></tt>`)).toEqual([
      {start: 1, end: 2, text: 'first line\nsecond line'},
      {start: 3, end: 4, text: 'one line'},
      {start: 5, end: 6, text: 'collapsed here kept\nthen'},
    ]);
  });

  it('splits a p at the times of its spans', async function() {
    expect(await cuesOf(ROLL)).toEqual([
      {start: 10, end: 11, text: 'one'},
      {start: 11, end: 12, text: 'one two'},
      {start: 12, end: 13, text: 'one two three'},
      {start: 13, end: 14, text: 'one two'},
      {start: 20, end: 21, text: 'first'},
      {start: 21, end: 22, text: 'second'},
    ]);
  });

  it('meets times computed apart without a sliver of a cue between them', async function() {
    // 0.1 + 0.2 is 0.30000000000000004, the other span's begin 0.3.
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="0s" end="1s"><span begin="0.1s"><span end="0.2s">a</span></span><span begin="0.3s">b</span></p>
    </div></body></tt>`)).toEqual([
      {start: 0.1, end: 0.3, text: 'a'},
      {start: 0.3, end: 1, text: 'b'},
    ]);
  });

  it('keeps cues at the same time and overlapping ones, each its own', async function() {
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml"><body>
      <div><p begin="1s" end="5s">sign</p><p begin="1s" end="2s">left</p></div>
      <div><p begin="1s" end="2s">right</p><p begin="1.5s" end="3s">later</p></div>
    </body></tt>`)).toEqual([
      {start: 1, end: 5, text: 'sign'},
      {start: 1, end: 2, text: 'left'},
      {start: 1, end: 2, text: 'right'},
      {start: 1.5, end: 3, text: 'later'},
    ]);
  });

  it('reads Unicode and XML character references as they are', async function() {
    expect(await cuesOf(`<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="1s" end="2s">&#x1F600; &quot;Grüße&quot; &apos;日本語&apos; مرحبا e&#x301;</p>
      <p begin="3s" end="4s">Bonjour&#160;! 「あ」&#x3000;「い」</p>
    </div></body></tt>`)).toEqual([
      {start: 1, end: 2, text: '\u{1F600} "Grüße" \'日本語\' مرحبا e\u0301'},
      // No-break and ideographic spaces are text, not white space to collapse.
      {start: 3, end: 4, text: 'Bonjour\u00A0! 「あ」\u3000「い」'},
    ]);
  });

  it('shows ruby as ruby, without its fallback delimiters', async function() {
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body><div>
      <p begin="1s" end="2s"><span tts:ruby="container"><span tts:ruby="base">漢</span><span tts:ruby="delimiter">(</span><span tts:ruby="text">かん</span><span tts:ruby="delimiter">)</span></span>字</p>
    </div></body></tt>`)).toEqual([{start: 1, end: 2, text: '<ruby>漢<rt>かん</rt></ruby>字'}]);
  });

  it('keeps the text of cues with no times or unreadable ones, and leaves out what TTML does not show', async function() {
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:x="urn:other"><body><div>
      <p>no times</p>
      <p begin="soon" end="later">unreadable times</p>
      <p begin="5s" end="4s">ends before it begins</p>
      <p begin="6s" end="7s">shown<metadata>not shown</metadata><set begin="0s" tts:color="red"/><x:note>foreign</x:note></p>
      <p begin="8s" end="9s"></p>
    </div></body></tt>`)).toEqual([
      // Open: ended where the next cue starts.
      {start: 0, end: 6, text: 'no times'},
      {start: 0, end: 6, text: 'unreadable times'},
      {start: 6, end: 7, text: 'shown'},
    ]);
  });

  it('says why a broken, entity-declaring or image document gives no cues; an empty one has none', async function() {
    const unreadable = 'Error: This TTML or DFXP subtitle file could not be read.';
    const broken = await cuesOf('<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="2s">open');
    expect(broken).toMatch(/^Error: This TTML or DFXP subtitle file could not be read\. \(XML Parsing Error: .+\)$/);
    expect(await cuesOf('<tt xmlns="http://www.w3.org/ns/ttml"><body><p>a</b></body></tt>')).toContain(unreadable);
    // Billion laughs: refused before the parser sees it, at once.
    const laughs = '<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]>' +
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="1s" end="2s">&d;</p></body></tt>';
    const started = Date.now();
    expect(await cuesOf(laughs)).toBe(`${unreadable} (entity declarations are not read)`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await cuesOf(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:smpte="http://www.smpte-ra.org/schemas/2052-1/2010/smpte-tt">
      <head><metadata><smpte:image xml:id="i1" imageType="PNG" encoding="Base64">iVBORw0KGgo=</smpte:image></metadata></head>
      <body><div begin="1s" end="2s" smpte:backgroundImage="#i1"/></body></tt>`))
        .toBe('Error: This TTML file holds its subtitles as images, which FastStream cannot show.');
    expect(await cuesOf('<tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>')).toEqual([]);
    expect(await cuesOf('<?xml version="1.0"?><transcript><text start="1" dur="2">old format</text></transcript>'))
        .toEqual([{start: 1, end: 3, text: 'old format'}]);
  });

  it('loads nothing a document names: no DTD, no style sheet, no image', async function() {
    const asked = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url);
      res.writeHead(200, {'Content-Type': 'application/xml-dtd', 'Access-Control-Allow-Origin': '*'});
      res.end('<!ELEMENT tt ANY>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    try {
      const cues = await cuesOf(`<?xml version="1.0"?>
        <?xml-stylesheet type="text/css" href="${origin}/style.css"?>
        <!DOCTYPE tt SYSTEM "${origin}/tt.dtd">
        <tt xmlns="http://www.w3.org/ns/ttml" xmlns:h="http://www.w3.org/1999/xhtml"><body><div>
          <p begin="1s" end="2s">&lt;script&gt;alert(1)&lt;/script&gt; <h:img src="${origin}/img.png"/><h:script>alert(2)</h:script></p>
        </div></body></tt>`);
      // Long enough for a request the parser would have started.
      await browser.pause(500);
      expect(cues).toEqual([{start: 1, end: 2, text: '&lt;script&gt;alert(1)&lt;/script&gt;'}]);
      expect(asked).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads a large file in reasonable time', async function() {
    const result = await browser.execute(() => new Promise((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const body = Array.from({length: 20000}, (_, i) => `<p begin="${i}s" end="${i + 0.5}s" style="s">line <span tts:fontStyle="italic">${i}</span></p>`).join('');
        const text = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><head><styling>' +
          '<style xml:id="s" tts:color="yellow"/></styling></head><body><div>' + body + '</div></body></tt>';
        const started = performance.now();
        const track = new SubtitleTrack('big', 'en');
        track.loadText(text);
        done({cues: track.cues.length, ms: performance.now() - started, last: track.cues[19999].text});
      }).catch((e) => done(String(e)));
    }));
    console.log('       20000 TTML cues read in', Math.round(result.ms), 'ms');
    expect(result.cues).toBe(20000);
    expect(result.last).toBe('<c.yellow>line </c><c.yellow><i>19999</i></c>');
    expect(result.ms).toBeLessThan(5000);
  });

  it('refuses a document that is more work to read, or gives more cue text, than a subtitle file', async function() {
    /**
     * @param {number} stretches - One p of that many seconds, with a one-second span for each.
     * @param {string} [before] - What stands in the p before those spans, shown the whole time.
     * @param {string} [head]
     * @return {Promise<number|string>} How many cues, or the error's message.
     */
    const read = (stretches, before = '', head = '') => browser.execute((text) => new Promise((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const track = new SubtitleTrack('t', 'en');
        track.loadText(text);
        done(track.cues.length);
      }).catch((e) => done(String(e)));
    }), `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">${head}<body><div><p begin="0s" end="${stretches}s">${before}` +
      Array.from({length: stretches}, (_, i) => `<span begin="${i}s" end="${i + 1}s">w${i}</span>`).join('') + '</p></div></body></tt>');
    const tooMuchWork = 'Error: This TTML or DFXP subtitle file could not be read. (reading it is more work than a subtitle file is)';
    const many = (/** @type {number} */ length, /** @type {(i: number) => string} */ each) => Array.from({length}, (_, i) => each(i)).join('');

    expect(await read(1000)).toBe(1000);
    // The p is read again for every stretch: its spans, its white space, its comments, the styles its spans name.
    expect(await read(5000)).toBe(tooMuchWork);
    expect(await read(2500, ' '.repeat(1900000))).toBe(tooMuchWork);
    expect(await read(2000, '<!---->'.repeat(200000))).toBe(tooMuchWork);
    expect(await read(1000, '<span style="all">a</span>'.repeat(1000), `<head><styling>${many(1000, (i) => `<style xml:id="s${i}" tts:color="red"/>`)}` +
      `<style xml:id="all" style="${many(1000, (i) => `s${i} `)}"/></styling></head>`)).toBe(tooMuchWork);
    expect(await read(1000, 'x'.repeat(20000)))
        .toBe('Error: This TTML or DFXP subtitle file could not be read. (its cues hold more text than is read)');
  });

  it('adds a .ttml, .dfxp or TTML .xml file from disk, and refuses other XML', async function() {
    expect(await addFile('episode.en.ttml', IMSC)).toEqual({label: 'episode.en.ttml', cues: 4});
    expect(await addFile('episode.de.dfxp', DFXP)).toEqual({label: 'episode.de.dfxp', cues: 4});
    expect(await addFile('episode.fr.xml', EBU)).toEqual({label: 'episode.fr.xml', cues: 1});
    expect(await addFile('feed.xml', '<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>')).toBe('never added');
  });
});

describe('TTML subtitles on screen', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.player),
        {timeout: 60000, timeoutMsg: 'the player never loaded'});
    await browser.execute(() => window.fastStream.currentVideo.pause());
  });

  it('draws styled TTML cues with the subtitle settings, moves with the sync, and adds a twin once', async function() {
    const result = await browser.execute((styles) => new Promise((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const client = window.fastStream;
        const manager = client.interfaceController.subtitlesManager;
        const ttml = new SubtitleTrack('TTML', 'en');
        ttml.loadText(styles);
        const vtt = new SubtitleTrack('VTT', 'en');
        vtt.loadText('WEBVTT\n\n00:01.000 --> 00:02.000\nplain\n');
        const added = client.loadSubtitleTrack(ttml);
        client.loadSubtitleTrack(vtt);
        manager.activateTrack(added);
        manager.activateTrack(vtt);
        const tracksBefore = manager.tracks.length;
        // The same file found again (a page's track and a download): one track.
        const twin = new SubtitleTrack('TTML', 'en');
        twin.loadText(styles);
        const again = client.loadSubtitleTrack(twin);

        const shownAt = (time, track) => {
          client.state.currentTime = time;
          manager.renderSubtitles();
          const container = manager.subtitleTrackDisplayElements[manager.activeTracks.indexOf(track)];
          return container.style.opacity === '0' ? null : container;
        };
        // Read before the next render, which replaces what is on screen.
        const box = (element) => {
          const style = getComputedStyle(element);
          return JSON.stringify([style.fontSize, style.fontFamily, style.backgroundColor, style.textShadow]);
        };
        const at3 = shownAt(3.5, added);
        const span = at3.querySelector('span');
        const shown = {
          text: at3.textContent,
          color: span && getComputedStyle(span).color,
          bold: !!at3.querySelector('b'),
          underline: !!at3.querySelector('u'),
        };
        const ttmlBox = box(at3);
        shown.sameBox = ttmlBox === box(shownAt(1.5, vtt));
        // The sync tool's shift: the cue comes a second later.
        added.shift(1);
        const before = shownAt(3.5, added)?.textContent ?? null;
        const after = shownAt(4.5, added)?.textContent ?? null;
        done({shown, before, after, sameTrack: again === added, tracks: manager.tracks.length - tracksBefore});
      }).catch((e) => done({error: String(e)}));
    }), STYLES);
    console.log('      ', JSON.stringify(result));
    expect(result.error).toBeUndefined();
    expect(result.shown).toEqual({text: 'yellow, bold, underlined', color: 'rgb(255, 255, 0)', bold: true, underline: true, sameBox: true});
    expect(result.before).toBeNull();
    expect(result.after).toBe('yellow, bold, underlined');
    expect(result.sameTrack).toBe(true);
    expect(result.tracks).toBe(0);
  });
});
