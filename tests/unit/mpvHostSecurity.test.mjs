import {PassThrough} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {
  CommandLineEnv,
  MaxMessageBytes,
  TooLarge,
  mpvTargetUrl,
  readMessage,
  relayHeaderFields,
  runPowerShell,
  withoutFsTags,
  wmiLaunchLines,
} from '../../native-host/faststream-mpv-host.mjs';

// A page could make "Send to mpv" run PowerShell code. It framed the player page (it is
// web-accessible) with a source whose faststream-headers held a Referer like
// x’;k=(Get-Date).Year;z=’, and the host spliced mpv's command line into the PowerShell
// that starts mpv, as a single-quoted string with only the ASCII ' escaped. PowerShell
// also ends such a string at the typographic quotes U+2018-U+201B, so the value closed
// the string and the rest ran. The command line now reaches the script through an
// environment variable, and header values are checked on both sides.

// The four characters PowerShell takes for a single quote besides the ASCII one.
const TYPOGRAPHIC_QUOTES = [0x2018, 0x2019, 0x201A, 0x201B].map((c) => String.fromCodePoint(c));
const RQ = TYPOGRAPHIC_QUOTES[1];

/**
 * One native-messaging frame, as Firefox writes it.
 * @param {Object|Buffer} body - The message, or raw bytes.
 * @param {number} [length] - The length prefix, if not the body's own.
 * @return {Buffer}
 */
function frame(body, length) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(length ?? payload.length, 0);
  return Buffer.concat([header, payload]);
}

describe('the WMI launch script', () => {
  it('holds no data: the command line is read from the environment', () => {
    const script = wmiLaunchLines().join('\n');
    expect(script).toContain('CommandLine=$env:' + CommandLineEnv);
    expect(script).not.toMatch(/CommandLine='/);
  });

  // The real script, run by the real PowerShell, with Invoke-CimMethod stubbed (a
  // function wins over the cmdlet) so nothing is started: the stub prints the command
  // line it was handed. A value that closes the string would add its own keys to the
  // hashtable and run their expressions first.
  it.runIf(process.platform === 'win32')('hands a hostile command line over as data, verbatim', async () => {
    const payloads = TYPOGRAPHIC_QUOTES.concat('\'').map((q) =>
      `"C:\\mpv\\mpv.exe" "--http-header-fields-append=Referer: x${q};k=$([Console]::Out.WriteLine('INJECTED'));z=${q}" -- "https://cdn.test/v.m3u8"`);
    for (const commandLine of payloads) {
      const stub = [
        // The console's code page would turn the typographic quotes into '?'.
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments)',
        '  [Console]::Out.WriteLine("KEYS=" + $Arguments.Count)',
        '  [Console]::Out.WriteLine("GOT=" + $Arguments.CommandLine)',
        '  [pscustomobject]@{ReturnValue = 9; ProcessId = 0} }',
      ];
      const out = await runPowerShell(stub.concat(wmiLaunchLines()), 60000, {[CommandLineEnv]: commandLine});
      const lines = out.split(/\r?\n/);
      // Evaluated, the payload prints INJECTED on a line of its own; as data, only
      // inside the GOT= line.
      expect(lines).not.toContain('INJECTED');
      expect(lines).toContain('KEYS=1');
      expect(lines).toContain('GOT=' + commandLine);
      expect(out).toContain('RC=9');
    }
  }, 120000);
});

describe('relayHeaderFields', () => {
  it('keeps Referer, Origin and User-Agent with printable ASCII values', () => {
    expect(relayHeaderFields([
      {name: 'Referer', value: 'https://site.test/watch?v=1&t=2'},
      {name: 'origin', value: 'https://site.test'},
      {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/156.0'},
    ])).toEqual([
      'Referer: https://site.test/watch?v=1&t=2',
      'origin: https://site.test',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/156.0',
    ]);
  });

  it.each(TYPOGRAPHIC_QUOTES.map((q) => [q.codePointAt(0).toString(16), q]))(
      'drops a value with the typographic quote U+%s', (hex, quote) => {
        expect(relayHeaderFields([{name: 'Referer', value: `x${quote};k=1;z=${quote}`}])).toEqual([]);
      });

  it.each([
    ['CR LF (a second header)', 'https://site.test/\r\nX-Evil: 1'],
    ['a NUL', 'https://site.test/' + String.fromCharCode(0)],
    ['non-ASCII', 'https://site.test/vidéo'],
    ['nothing', ''],
    ['over 4096 characters', 'https://site.test/' + 'a'.repeat(4096)],
  ])('drops a value with %s', (what, value) => {
    expect(relayHeaderFields([{name: 'Referer', value}])).toEqual([]);
  });

  it('drops headers mpv is never given, and anything that is not a header', () => {
    expect(relayHeaderFields([
      {name: 'Cookie', value: 'a=b'},
      {name: 'X-Forwarded-For', value: '1.2.3.4'},
      {name: 'Referer', value: 5},
      null,
      'Referer: x',
    ])).toEqual([]);
    expect(relayHeaderFields(undefined)).toEqual([]);
    expect(relayHeaderFields({name: 'Referer', value: 'x'})).toEqual([]);
  });
});

describe('fs-* tags a page put in the stream URL', () => {
  it('are dropped, so only the host\'s own reach mpv', () => {
    const url = mpvTargetUrl({
      url: 'https://cdn.test/v.m3u8#fs-id=0000000000000000&fs-page=https%3A%2F%2Fevil.test%2F&fs-content=anime',
      pageUrl: 'https://site.test/watch/1',
      contentType: 'movie',
    });
    const fragment = new URL(url).hash.slice(1).split('&');
    expect(fragment.filter((tag) => tag.startsWith('fs-id='))).toHaveLength(1);
    expect(fragment).not.toContain('fs-id=0000000000000000');
    expect(fragment).toContain('fs-content=movie');
    expect(fragment).not.toContain('fs-content=anime');
    expect(fragment).toContain('fs-page=' + encodeURIComponent('https://site.test/watch/1'));
  });

  it('keep the rest of the fragment', () => {
    expect(withoutFsTags('https://cdn.test/v.mp4#t=10&fs-id=1')).toBe('https://cdn.test/v.mp4#t=10');
    expect(withoutFsTags('https://cdn.test/v.mp4#FS-ID=1')).toBe('https://cdn.test/v.mp4');
    expect(withoutFsTags('https://cdn.test/v.mp4#t=10')).toBe('https://cdn.test/v.mp4#t=10');
    expect(withoutFsTags('https://cdn.test/v.mp4')).toBe('https://cdn.test/v.mp4');
  });
});

describe('readMessage', () => {
  it('reads a message split across chunks', async () => {
    const input = new PassThrough();
    const read = readMessage(input);
    const bytes = frame({type: 'open', url: 'https://cdn.test/v.m3u8'});
    input.write(bytes.subarray(0, 2));
    input.write(bytes.subarray(2, 9));
    input.write(bytes.subarray(9));
    expect(await read).toEqual({type: 'open', url: 'https://cdn.test/v.m3u8'});
  });

  it('refuses a length prefix over the limit instead of allocating it', async () => {
    // Read past, not kept: TooLarge once the stated bytes have gone by (the host answers
    // it), null when the input ends first.
    const huge = frame(Buffer.from('{}'), 0xFFFFFFFF);
    const big = frame(Buffer.alloc(MaxMessageBytes + 1, 0x20));
    const alloc = vi.spyOn(Buffer, 'alloc');
    try {
      let input = new PassThrough();
      let read = readMessage(input);
      input.end(huge);
      expect(await read).toBeNull();

      input = new PassThrough();
      read = readMessage(input);
      input.write(big);
      expect(await read).toBe(TooLarge);
      expect(alloc.mock.calls.filter(([size]) => size > MaxMessageBytes)).toEqual([]);
    } finally {
      alloc.mockRestore();
    }
  });

  it('reads a message right at the limit', async () => {
    const input = new PassThrough();
    const read = readMessage(input);
    const url = 'https://cdn.test/' + 'a'.repeat(MaxMessageBytes - 40);
    const body = Buffer.from(JSON.stringify({url}), 'utf8');
    expect(body.length).toBeLessThanOrEqual(MaxMessageBytes);
    input.write(frame(body));
    expect((await read).url).toBe(url);
  });

  it('gives null for a stream that ends early or holds no JSON', async () => {
    let input = new PassThrough();
    let read = readMessage(input);
    input.end(frame({a: 1}).subarray(0, 6));
    expect(await read).toBeNull();

    input = new PassThrough();
    read = readMessage(input);
    input.write(frame(Buffer.from('not json' + RQ)));
    expect(await read).toBeNull();
  });
});
