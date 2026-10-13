import {describe, expect, it} from 'vitest';
import {
  MaxIpcCommands,
  MaxOnStopCommands,
  MaxTargetBytes,
  MinHeartbeatMs,
  ReadableProperties,
  SettableProperties,
  allowedIpcCommand,
  checkPlayMessage,
  checkRelayMessage,
  ipcCommandRefusal,
  isPlainText,
} from '../../native-host/faststream-mpv-host.mjs';

// Host 15, the thin helper: the extension sends mpv commands (ipc, relay) and a play message,
// and these checks are the security boundary between them and mpv. A compromised extension
// must get no more than before: mpv on an http(s) URL with Referer, Origin and User-Agent, a
// title, a start and subtitle files. Nothing it sends may make mpv or the helper run a program,
// load a script, read or write a file of its choosing, or open anything but http(s). Default
// deny: every allowed shape is listed here, and many refused ones.

// Control characters, from their codes: the file tools turn escapes into the characters.
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const CONTROL = [NUL, TAB, LF, CR, ESC, DEL, String.fromCharCode(31)];
const BACKSLASH = String.fromCharCode(92);
// '${', which mpv expands in show-text: ${working-directory} would print a local path.
const EXPAND = '$' + '{';

describe('isPlainText', () => {
  it('takes a string of at most max characters without control characters', () => {
    expect(isPlainText('', 10)).toBe(true);
    expect(isPlainText('Next episode: loading', 100)).toBe(true);
    expect(isPlainText('x'.repeat(10), 10)).toBe(true);
    expect(isPlainText('x'.repeat(11), 10)).toBe(false);
    // Non-ASCII is text: an accent, a CJK title, an emoji.
    expect(isPlainText('Jos' + String.fromCodePoint(0xE9, 0x4E2D, 0x1F3AC), 10)).toBe(true);
  });

  it('refuses every control character, 127 included, anywhere in the text', () => {
    for (const c of CONTROL) {
      expect(isPlainText(c, 10), JSON.stringify(c)).toBe(false);
      expect(isPlainText('a' + c + 'b', 10), JSON.stringify(c)).toBe(false);
    }
    // 32 (space) and 126 (~) are the bounds that pass.
    expect(isPlainText(' ~', 10)).toBe(true);
  });

  it('refuses ${ only when asked to', () => {
    expect(isPlainText(EXPAND + 'path}', 100)).toBe(true);
    expect(isPlainText(EXPAND + 'path}', 100, true)).toBe(false);
    expect(isPlainText('cost: $5 {x}', 100, true)).toBe(true);
  });

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 5, true, ['a'], {}]) {
      expect(isPlainText(value, 10)).toBe(false);
    }
  });
});

describe('the IPC allowlist (ipcCommandRefusal, allowedIpcCommand)', () => {
  /**
   * Expects a command to pass, with no reason given.
   * @param {*} command
   */
  const allowed = (command) => {
    expect(ipcCommandRefusal(command), JSON.stringify(command)).toBeNull();
    expect(allowedIpcCommand(command)).toBe(true);
  };
  /**
   * Expects a command to be refused, with a reason.
   * @param {*} command
   * @param {RegExp} [reason]
   */
  const refused = (command, reason = /./) => {
    const why = ipcCommandRefusal(command);
    expect(why, JSON.stringify(command)).toMatch(reason);
    expect(allowedIpcCommand(command)).toBe(false);
  };

  describe('reading properties', () => {
    it('reads each of the readable properties, and FastStream\'s user-data', () => {
      expect([...ReadableProperties].sort()).toEqual([
        'core-idle', 'demuxer-cache-duration', 'duration', 'eof-reached', 'fullscreen', 'height',
        'hwdec', 'hwdec-current', 'idle-active', 'media-title', 'mute', 'path', 'pause',
        'paused-for-cache', 'percent-pos', 'pid', 'playback-time', 'speed', 'time-pos',
        'time-remaining', 'video-format', 'volume', 'width',
      ]);
      for (const name of [...ReadableProperties, 'user-data/faststream/connected',
        'user-data/faststream/heartbeat', 'user-data/faststream/a/b_c-1/2']) {
        allowed(['get_property', name]);
        allowed(['observe_property', 1, name]);
      }
      allowed(['observe_property', 0, 'path']);
      allowed(['observe_property', -3, 'path']);
      allowed(['observe_property', 2 ** 40, 'eof-reached']);
      allowed(['unobserve_property', 1]);
    });

    it('never reads options, paths, bindings or the configuration', () => {
      for (const name of ['options/sub-files', 'options/input-conf', 'options/script-opts', 'options/include',
        'options/scripts', 'options', 'working-directory', 'property-list', 'mpv-configuration',
        'input-bindings', 'command-list', 'stream-open-filename', 'playlist', 'track-list',
        'demuxer-cache-state', 'script-opts', 'filename', 'user-data', 'user-data/other',
        'user-data/faststream', 'user-data/faststream/', 'user-data/faststream//x',
        'user-data/faststream/../options', 'user-data/faststream/Upper', 'user-data/faststream/a b',
        'user-data/faststreamx/y', 'PATH', 'path ', ' path', 'path/x', '']) {
        refused(['get_property', name], /property not allowed/);
        refused(['observe_property', 1, name], /property not allowed/);
      }
    });

    it('checks every argument\'s type and number', () => {
      refused(['get_property'], /get_property/);
      refused(['get_property', 'path', 'extra'], /get_property/);
      refused(['get_property', 5]);
      refused(['get_property', ['path']]);
      refused(['get_property', null]);
      refused(['observe_property', 'path']);
      refused(['observe_property', '1', 'path'], /integer id/);
      refused(['observe_property', 1.5, 'path'], /integer id/);
      refused(['observe_property', NaN, 'path'], /integer id/);
      refused(['observe_property', 2 ** 60, 'path'], /integer id/);
      refused(['observe_property', 1, 'path', 'extra'], /integer id/);
      refused(['unobserve_property'], /integer id/);
      refused(['unobserve_property', '1'], /integer id/);
      refused(['unobserve_property', 1, 2], /integer id/);
    });
  });

  describe('setting properties', () => {
    it('sets fullscreen, pause, volume, mute, speed and FastStream\'s user-data to a yes or no, a number or a text', () => {
      expect([...SettableProperties].sort()).toEqual(['fullscreen', 'mute', 'pause', 'speed', 'volume']);
      for (const name of [...SettableProperties, 'user-data/faststream/connected', 'user-data/faststream/autoplay',
        'user-data/faststream/heartbeat']) {
        for (const value of [true, false, 0, -1, 1.25, 1760000000000, '', 'yes', 'x'.repeat(4096)]) {
          allowed(['set_property', name, value]);
        }
      }
    });

    it('never sets an option, a script, an include or a config file', () => {
      for (const name of ['options/script-opts', 'script-opts', 'options/scripts', 'scripts', 'script', 'include',
        'options/include', 'input-conf', 'options/input-conf', 'sub-files', 'options/sub-files',
        'working-directory', 'stream-record', 'screenshot-directory', 'log-file', 'ytdl-raw-options',
        'http-header-fields', 'force-media-title', 'input-ipc-server', 'user-data', 'user-data/faststream',
        'user-data/other/x', 'user-data/faststream/../x', 'time-pos', 'path']) {
        refused(['set_property', name, 'x'], /property not allowed/);
        refused(['set_property', name, true], /property not allowed/);
      }
    });

    it('refuses values that are not a yes or no, a finite number or a plain text without ${', () => {
      for (const value of [null, undefined, NaN, Infinity, -Infinity, ['a'], {a: 1}, 'x'.repeat(4097),
        EXPAND + 'working-directory}', 'a' + EXPAND + 'path}b']) {
        refused(['set_property', 'user-data/faststream/x', value], /value not allowed/);
      }
      for (const c of CONTROL) {
        refused(['set_property', 'user-data/faststream/x', 'a' + c], /value not allowed/);
      }
    });

    it('takes exactly a name and a value', () => {
      refused(['set_property', 'pause'], /set_property/);
      refused(['set_property', 'pause', true, 'extra'], /set_property/);
      refused(['set_property'], /set_property/);
      refused(['set_property', 5, true], /set_property/);
    });
  });

  describe('notices (notify.lua)', () => {
    it('shows and hides FastStream\'s notice', () => {
      allowed(['script-message-to', 'notify', 'show', 'faststream', 'Next episode', 'loading']);
      allowed(['script-message-to', 'notify', 'show', 'faststream', 'Autoplay', '']);
      allowed(['script-message-to', 'notify', 'show', 'faststream', '', '']);
      allowed(['script-message-to', 'notify', 'show', 'faststream', 'x'.repeat(2048), 'y'.repeat(2048)]);
      for (const seconds of ['1', '5', '05', '59', '60']) {
        allowed(['script-message-to', 'notify', 'show', 'faststream', 'Autoplay', 'next in 5 s', seconds]);
      }
      allowed(['script-message-to', 'notify', 'hide', 'faststream']);
    });

    it('refuses seconds that are not whole seconds 1 to 60 as text (0 stays until hidden)', () => {
      for (const seconds of ['0', '00', '61', '99', '100', '5.5', '-1', '+5', ' 5', '5 ', '', '1e1', 5, null, true]) {
        refused(['script-message-to', 'notify', 'show', 'faststream', 'Autoplay', 'x', seconds], /seconds not allowed/);
      }
    });

    it('refuses a title or detail that is too long, holds a control character or ${', () => {
      const show = (title, detail) => ['script-message-to', 'notify', 'show', 'faststream', title, detail];
      refused(show('x'.repeat(2049), ''), /title or detail/);
      refused(show('', 'x'.repeat(2049)), /title or detail/);
      refused(show(EXPAND + 'working-directory}', ''), /title or detail/);
      refused(show('t', 'at ' + EXPAND + 'path}'), /title or detail/);
      for (const c of CONTROL) {
        refused(show('a' + c, ''), /title or detail/);
        refused(show('a', c), /title or detail/);
      }
      refused(show(5, ''), /title or detail/);
      refused(show('a', null), /title or detail/);
      refused(['script-message-to', 'notify', 'show', 'faststream', 'only a title'], /title, a detail/);
    });

    it('refuses notify.lua\'s other arguments, other ids, other sub-commands and other scripts', () => {
      // progress, side and icon (notify.lua's 8th to 10th): not FastStream's.
      refused(['script-message-to', 'notify', 'show', 'faststream', 't', 'd', '5', '0.5'], /title, a detail/);
      refused(['script-message-to', 'notify', 'show', 'faststream', 't', 'd', '5', '', 'left', 'icon'], /title, a detail/);
      refused(['script-message-to', 'notify', 'show', 'speed', 't', 'd'], /only show or hide of faststream/);
      refused(['script-message-to', 'notify', 'hide', 'speed'], /only faststream/);
      refused(['script-message-to', 'notify', 'hide', 'faststream', 'extra'], /only faststream/);
      refused(['script-message-to', 'notify', 'hide'], /only faststream/);
      for (const sub of ['clear', 'update', 'SHOW', 'show ', '', 5]) {
        refused(['script-message-to', 'notify', sub, 'faststream', 't', 'd'], /only show or hide/);
      }
      for (const target of ['uosc', 'console', 'stats', 'select', 'ytdl_hook', 'commands', 'auto_profiles',
        'faststream-quality', 'Notify', '']) {
        refused(['script-message-to', target, 'show', 'faststream', 't', 'd'], /only notify/);
      }
      refused(['script-message-to'], /only notify/);
      refused(['script-message-to', 'notify'], /only show or hide/);
    });
  });

  describe('script messages', () => {
    it('sends FastStream\'s own messages with at most 8 plain texts', () => {
      allowed(['script-message', 'faststream-next']);
      allowed(['script-message', 'faststream-previous']);
      allowed(['script-message', 'faststream-a', 'one', '', 'x'.repeat(2048)]);
      allowed(['script-message', 'faststream-' + 'a'.repeat(40), ...Array(8).fill('x')]);
      // Not expanded by mpv: a script gets the text as it is.
      allowed(['script-message', 'faststream-x', EXPAND + 'path}']);
    });

    it('refuses every other message name', () => {
      for (const name of ['faststream-', 'faststream-' + 'a'.repeat(41), 'faststream_next', 'FASTSTREAM-next',
        'faststream-Next', 'faststream-next x', 'faststream-next' + LF, 'fs-next', 'uosc-menu', 'osc-visibility',
        'select-menu', 'type', 'key', 'load-script', 'run', '', 5, null]) {
        refused(['script-message', name], /only faststream-\* messages/);
      }
      refused(['script-message'], /only faststream-\* messages/);
    });

    it('refuses more than 8 arguments, texts that are too long, control characters and non-strings', () => {
      refused(['script-message', 'faststream-x', ...Array(9).fill('x')], /too many arguments/);
      refused(['script-message', 'faststream-x', 'x'.repeat(2049)], /argument not allowed/);
      for (const c of CONTROL) {
        refused(['script-message', 'faststream-x', 'a' + c], /argument not allowed/);
      }
      for (const value of [5, true, null, ['a'], {a: 1}]) {
        refused(['script-message', 'faststream-x', value], /argument not allowed/);
      }
    });
  });

  describe('show-text', () => {
    it('shows a plain text, for 0 to 60000 milliseconds', () => {
      allowed(['show-text', 'Next episode: loading']);
      allowed(['show-text', '']);
      allowed(['show-text', 'x'.repeat(2048)]);
      allowed(['show-text', 'a', 0]);
      allowed(['show-text', 'a', 4000]);
      allowed(['show-text', 'a', 60000]);
      allowed(['show-text', 'cost $5 {not a property}']);
    });

    it('refuses ${, control characters, long texts, bad durations and extra arguments', () => {
      refused(['show-text', EXPAND + 'working-directory}'], /text not allowed/);
      refused(['show-text', EXPAND + 'osd-ass-cc/0}{' + BACKSLASH + 'fs200}x'], /text not allowed/);
      refused(['show-text', 'x'.repeat(2049)], /text not allowed/);
      for (const c of CONTROL) {
        refused(['show-text', 'a' + c + 'b'], /text not allowed/);
      }
      refused(['show-text', 5], /text not allowed/);
      for (const ms of [-1, 60001, 1.5, '4000', NaN, Infinity, null, true]) {
        refused(['show-text', 'a', ms], /milliseconds not allowed/);
      }
      refused(['show-text', 'a', 4000, 1], /a text and the milliseconds only/);
      refused(['show-text'], /a text and the milliseconds only/);
    });
  });

  describe('everything else', () => {
    it('refuses the commands that run programs, load scripts or files, or press keys', () => {
      for (const command of [
        ['run', 'calc.exe'],
        ['run', 'cmd', '/c', 'calc'],
        ['subprocess', ['calc.exe']],
        ['load-script', BACKSLASH + BACKSLASH + 'attacker.example' + BACKSLASH + 'hook.js'],
        ['load-script', 'C:/Users/x/Downloads/evil.lua'],
        ['loadfile', 'file:///C:/Windows/win.ini'],
        ['loadfile', 'https://cdn.test/v.m3u8', 'replace'],
        ['loadlist', 'C:/list.m3u'],
        ['script-binding', 'console/enable'],
        ['keypress', 'q'],
        ['keydown', 'q'],
        ['keybind', 'x', 'run calc'],
        ['expand-path', '~~/'],
        ['expand-text', EXPAND + 'path}'],
        ['quit'],
        ['quit-watch-later'],
        ['stop'],
        ['playlist-next'],
        ['screenshot-to-file', 'C:/x.png'],
        ['dump-cache', 0, 'no', 'C:/x.ts'],
        ['sub-add', 'C:/secret.srt'],
        ['audio-add', 'https://x.test/a.mp3'],
        ['write-watch-later-config'],
        ['change-list', 'script-opts', 'append', 'x=y'],
        ['add', 'volume', 10],
        ['cycle', 'pause'],
        ['set', 'pause', 'yes'],
        ['apply-profile', 'x'],
        ['load-config-file', 'C:/x.conf'],
        ['load-input-conf', 'C:/x.conf'],
        ['overlay-add', 1, 0, 0, 'C:/x.raw', 0, 'bgra', 1, 1, 4],
        ['script-message-to', 'console', 'type', 'run calc'],
        ['osd-auto', 'show-text', 'x'],
        ['no-osd', 'set_property', 'pause', true],
        ['GET_PROPERTY', 'path'],
        ['get_property ', 'path'],
      ]) {
        refused(command, /command not allowed|only notify/);
      }
    });

    it('refuses the object form and anything that is not a command array', () => {
      for (const command of [
        {name: 'get_property', name2: 'path'},
        {name: 'loadfile', url: 'file:///C:/Windows/win.ini'},
        {command: ['get_property', 'path']},
        'get_property path',
        'run calc',
        null,
        undefined,
        5,
        true,
        [],
        [['get_property', 'path']],
      ]) {
        refused(command, /not an array-form command|command not allowed/);
      }
    });

    it('names a refused command when it has a plain name, and only then', () => {
      expect(ipcCommandRefusal(['run', 'calc'])).toBe('command not allowed: run');
      expect(ipcCommandRefusal(['load-script', 'x'])).toBe('command not allowed: load-script');
      expect(ipcCommandRefusal(['x'.repeat(41)])).toBe('command not allowed');
      expect(ipcCommandRefusal(['run' + LF + 'x'])).toBe('command not allowed');
      expect(ipcCommandRefusal([5])).toBe('command not allowed');
    });
  });

  it('caps an ipc message at 32 commands and a relay\'s onStop at 8', () => {
    expect(MaxIpcCommands).toBe(32);
    expect(MaxOnStopCommands).toBe(8);
  });
});

describe('checkPlayMessage', () => {
  const target = 'https://cdn.test/hls/v.m3u8?token=1#fs-content=anime&fs-id=0123456789abcdef';

  it('passes a full play message on, as it was sent', () => {
    const subtitles = [{label: 'English', srt: '1' + LF + '00:00:01,000 --> 00:00:02,000' + LF + 'Hi'}];
    expect(checkPlayMessage({
      type: 'play', target, title: 'Show - Episode 3', start: '754.123',
      headers: ['Referer: https://site.test/a?b=1,2', 'Origin: https://site.test', 'User-Agent: UA (x, y)'],
      subtitles, fullscreen: true, newWindow: true,
    })).toEqual({ok: true, play: {
      target, title: 'Show - Episode 3', start: '754.123',
      headerFields: ['Referer: https://site.test/a?b=1,2', 'Origin: https://site.test', 'User-Agent: UA (x, y)'],
      subtitles, fullscreen: true, newWindow: true,
    }});
  });

  it('fills in what is missing: the host name as the title, no start, headers or subtitles, one window', () => {
    expect(checkPlayMessage({type: 'play', target})).toEqual({ok: true, play: {
      target, title: 'cdn.test', start: undefined, headerFields: [], subtitles: [], fullscreen: false, newWindow: false,
    }});
    for (const title of [undefined, null, '']) {
      expect(checkPlayMessage({target, title}).play.title).toBe('cdn.test');
    }
    expect(checkPlayMessage({target, start: null, headers: null, subtitles: null, fullscreen: null, newWindow: null}).ok)
        .toBe(true);
  });

  it('ignores fields it does not know, mpvPath among them: the extension never names the program', () => {
    const checked = checkPlayMessage({target, mpvPath: 'C:/Users/x/Downloads/mpv.exe', url: 'file:///x', extra: 1});
    expect(checked.ok).toBe(true);
    expect(Object.keys(checked.play).sort())
        .toEqual(['fullscreen', 'headerFields', 'newWindow', 'start', 'subtitles', 'target', 'title']);
    expect(JSON.stringify(checked)).not.toContain('Downloads');
  });

  describe('the target', () => {
    it('is an http(s) URL', () => {
      expect(checkPlayMessage({target: 'http://cdn.test/v.mp4'}).ok).toBe(true);
      expect(checkPlayMessage({target: 'HTTPS://CDN.test/v.mp4'}).ok).toBe(true);
      for (const bad of ['file:///C:/Windows/win.ini', 'file://server/share/v.mp4',
        'https:' + BACKSLASH + BACKSLASH + 'host' + BACKSLASH + 'share', BACKSLASH + BACKSLASH + 'host' + BACKSLASH + 'share',
        '//cdn.test/v.mp4', 'cdn.test/v.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AA', 'ftp://x.test/v',
        'edl://x', 'memory://x', 'av://dshow:video=x', 'ytdl://x', 'https:/x', 'https://', '', ' https://cdn.test/v',
        5, null, undefined, ['https://cdn.test/v'], {href: 'https://cdn.test/v'}]) {
        expect(checkPlayMessage({target: bad}), JSON.stringify(bad)).toEqual({ok: false, error: 'mpv is only given http(s) streams'});
      }
    });

    it('holds no control character (a newline would start a second line in the request)', () => {
      for (const c of [LF, CR, TAB, NUL, DEL, ESC]) {
        expect(checkPlayMessage({target: 'https://cdn.test/v.m3u8' + c + 'X-Evil: 1'}))
            .toEqual({ok: false, error: 'the stream URL holds a control character'});
      }
      // A space or a quote is no control character: mpv gets the URL as it is, over the pipe.
      expect(checkPlayMessage({target: 'https://cdn.test/a b".m3u8'}).ok).toBe(true);
    });

    it('is at most 512 KB', () => {
      const head = 'https://cdn.test/v.m3u8#fs-quality=';
      expect(checkPlayMessage({target: head + 'a'.repeat(MaxTargetBytes - head.length)}).ok).toBe(true);
      expect(checkPlayMessage({target: head + 'a'.repeat(MaxTargetBytes - head.length + 1)}))
          .toEqual({ok: false, error: 'the stream URL is too long for mpv'});
      // Bytes, as UTF-8: a character of three bytes counts three.
      const wide = String.fromCharCode(0x4E2D).repeat(Math.ceil(MaxTargetBytes / 3));
      expect(checkPlayMessage({target: head + wide}).ok).toBe(false);
    });
  });

  it('takes a title of one line of at most 1000 characters', () => {
    expect(checkPlayMessage({target, title: 'x'.repeat(1000)}).play.title).toHaveLength(1000);
    for (const title of ['x'.repeat(1001), 'a' + LF + 'b', 'a' + TAB, DEL, 5, true, ['t'], {t: 1}]) {
      expect(checkPlayMessage({target, title}), JSON.stringify(title))
          .toEqual({ok: false, error: 'the title is not one line of at most 1000 characters'});
    }
  });

  it('takes a start of seconds as text, at most 7 digits and 3 decimals', () => {
    for (const start of ['0', '1', '754.5', '754.123', '9999999.999']) {
      expect(checkPlayMessage({target, start}).play.start).toBe(start);
    }
    for (const start of ['12345678', '1.2345', '-1', '+5', '1e3', '50%', '#3', ' 12', '12 ', '1.', '.5', '',
      '1,5', '00:12', 12, 0, true, ['1']]) {
      expect(checkPlayMessage({target, start}), JSON.stringify(start))
          .toEqual({ok: false, error: 'the start is not a number of seconds'});
    }
  });

  describe('the headers', () => {
    const headerError = {ok: false, error: 'a header is not Referer, Origin or User-Agent with a printable ASCII value'};

    it('are Referer, Origin and User-Agent of printable ASCII, in any case', () => {
      const headers = ['referer: https://a.test/', 'ORIGIN: https://a.test', 'User-agent: Mozilla/5.0 (X11; rv:1) ~!'];
      expect(checkPlayMessage({target, headers}).play.headerFields).toEqual(headers);
      expect(checkPlayMessage({target, headers: ['Referer: ' + 'x'.repeat(4096)]}).ok).toBe(true);
    });

    it('refuses any other header, form or value', () => {
      for (const header of ['Cookie: a=b', 'X-Evil: 1', 'Authorization: Bearer x', 'Range: bytes=0-', 'Host: x.test',
        'Referer:https://a.test/', 'Referer : x', ' Referer: x', 'Referer: ', 'Referer: ' + 'x'.repeat(4097),
        'Referer: https://a.test/' + CR + LF + 'X-Evil: 1', 'Referer: x' + LF, 'Referer: ' + TAB + 'x',
        'Referer: caf' + String.fromCharCode(0xE9), 'Referer: x' + String.fromCharCode(0x2019) + 'y', 5, null,
        {name: 'Referer', value: 'https://a.test/'}, ['Referer: x']]) {
        expect(checkPlayMessage({target, headers: [header]}), JSON.stringify(header)).toEqual(headerError);
      }
    });

    it('refuses a header ending in a backslash, which would swallow the next one in mpv\'s list', () => {
      // mpv reads "\," as an escaped comma: the Referer took the User-Agent in (measured).
      expect(checkPlayMessage({target, headers: ['Referer: https://a.test/x' + BACKSLASH, 'User-Agent: UA']}))
          .toEqual({ok: false, error: 'a header ends in a backslash'});
      // Inside the value a backslash is just a character.
      expect(checkPlayMessage({target, headers: ['Referer: https://a.test/' + BACKSLASH + 'x']}).ok).toBe(true);
    });

    it('are a list of at most 8', () => {
      expect(checkPlayMessage({target, headers: Array(8).fill('Origin: https://a.test')}).ok).toBe(true);
      for (const headers of [Array(9).fill('Origin: https://a.test'), 'Referer: x', {0: 'Referer: x'}, 5]) {
        expect(checkPlayMessage({target, headers})).toEqual({ok: false, error: 'the headers are not a list of at most 8'});
      }
    });
  });

  describe('the subtitles', () => {
    const srt = '1' + LF + '00:00:01,000 --> 00:00:02,000' + LF + 'Hi';

    it('are at most 8 SubRip texts with labels; empty ones are left out', () => {
      const eight = Array.from({length: 8}, (unused, i) => ({label: 'L' + i, srt}));
      expect(checkPlayMessage({target, subtitles: eight}).play.subtitles).toEqual(eight);
      expect(checkPlayMessage({target, subtitles: [{srt}, {label: 'Empty', srt: '  '}]}).play.subtitles)
          .toEqual([{label: '', srt}]);
    });

    it('refuses more than 8, and entries that are not {label, srt} texts', () => {
      const error = {ok: false, error: 'the subtitles are not at most 8 SubRip texts with labels'};
      expect(checkPlayMessage({target, subtitles: Array(9).fill({label: 'x', srt})})).toEqual(error);
      for (const entry of [null, 5, 'srt', {label: 'x'}, {label: 'x', srt: 5}, {label: 5, srt},
        {label: 'x', srt: 'x'.repeat(1024 * 1024 + 1)}, {label: null, srt}]) {
        expect(checkPlayMessage({target, subtitles: [entry]}), JSON.stringify(entry).slice(0, 80)).toEqual(error);
      }
      expect(checkPlayMessage({target, subtitles: {label: 'x', srt}})).toEqual(error);
    });
  });

  it('takes fullscreen and newWindow as a yes or no only', () => {
    for (const value of ['yes', 1, 0, 'true', {}, []]) {
      expect(checkPlayMessage({target, fullscreen: value})).toEqual({ok: false, error: 'fullscreen and newWindow are a yes or no'});
      expect(checkPlayMessage({target, newWindow: value})).toEqual({ok: false, error: 'fullscreen and newWindow are a yes or no'});
    }
  });
});

describe('checkRelayMessage', () => {
  it('takes no options, a heartbeat and onStop commands', () => {
    expect(checkRelayMessage({type: 'relay'})).toEqual({ok: true, heartbeat: null, onStop: []});
    const onStop = [['set_property', 'user-data/faststream/connected', false], ['script-message-to', 'notify', 'hide', 'faststream']];
    expect(checkRelayMessage({type: 'relay', heartbeat: {property: 'user-data/faststream/heartbeat', everyMs: 30000}, onStop}))
        .toEqual({ok: true, heartbeat: {property: 'user-data/faststream/heartbeat', everyMs: 30000}, onStop});
    expect(checkRelayMessage({heartbeat: {property: 'user-data/faststream/a/b', everyMs: MinHeartbeatMs}}).ok).toBe(true);
    expect(checkRelayMessage({onStop: Array(8).fill(['set_property', 'pause', true])}).ok).toBe(true);
  });

  it('refuses a heartbeat on any other property, more often than every 5 s, or past what a timer can wait', () => {
    for (const heartbeat of [
      {property: 'options/input-conf', everyMs: 30000},
      {property: 'pause', everyMs: 30000},
      {property: 'user-data/other', everyMs: 30000},
      {property: 'user-data/faststream', everyMs: 30000},
      {property: 'user-data/faststream/heartbeat', everyMs: 4999},
      {property: 'user-data/faststream/heartbeat', everyMs: 0},
      {property: 'user-data/faststream/heartbeat', everyMs: 5000.5},
      {property: 'user-data/faststream/heartbeat', everyMs: '30000'},
      {property: 'user-data/faststream/heartbeat', everyMs: 2 ** 31},
      {property: 'user-data/faststream/heartbeat'},
      {everyMs: 30000},
      'user-data/faststream/heartbeat',
      30000,
      [],
    ]) {
      const checked = checkRelayMessage({heartbeat});
      expect(checked.ok, JSON.stringify(heartbeat)).toBe(false);
      expect(checked.error).toMatch(/heartbeat/);
    }
  });

  it('refuses more than 8 onStop commands, or one the allowlist refuses, naming it', () => {
    expect(checkRelayMessage({onStop: Array(9).fill(['set_property', 'pause', true])}))
        .toEqual({ok: false, error: 'onStop is not a list of at most 8 commands'});
    expect(checkRelayMessage({onStop: ['set_property', 'pause', true]}).ok).toBe(false);
    expect(checkRelayMessage({onStop: {}}).ok).toBe(false);
    expect(checkRelayMessage({onStop: [['set_property', 'pause', true], ['run', 'calc']]}))
        .toEqual({ok: false, error: 'onStop command 1 refused: command not allowed: run'});
    expect(checkRelayMessage({onStop: [['set_property', 'options/script-opts', 'x']]}))
        .toEqual({ok: false, error: 'onStop command 0 refused: set_property: property not allowed'});
  });
});
