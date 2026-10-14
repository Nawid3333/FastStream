// The e2e mpv specs close the mpv windows they started, and only those
// (tests/e2e/mpvTestProcesses.mjs). The thin helper (host 15) starts mpv with no stream on
// its command line and loads the stream over mpv's IPC pipe, so the specs found none of
// theirs and left their windows open (2026-10-14). Here a stand-in for mpv's IPC server
// answers as mpv does; no mpv is started.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {ipcServerOf, specMpvPids} from '../e2e/mpvTestProcesses.mjs';

const Site = 'http://127.0.0.1:41994';
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** @return {string} A fresh IPC path: a named pipe on Windows, a socket elsewhere, as mpv's. */
function ipcPath() {
  const name = `faststream-mpv-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * A stand-in for an mpv's IPC server.
 * @param {Array<string>} playlist - The files in its playlist.
 * @param {{silent: (boolean|undefined)}=} options - silent: it never answers.
 * @return {Promise<{server: string, commands: Array<Array<*>>}>} Its path, and the commands
 *   it received.
 */
async function fakeMpv(playlist, {silent = false} = {}) {
  const commands = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const request = JSON.parse(line);
        commands.push(request.command);
        if (silent) continue;
        // mpv's events share the pipe with the answers.
        socket.write(JSON.stringify({event: 'playback-restart'}) + '\n');
        const data = playlist.map((filename, i) => ({filename, current: i === 0, playing: i === 0}));
        socket.write(JSON.stringify({data, request_id: request.request_id, error: 'success'}) + '\n');
      }
    });
  });
  const where = ipcPath();
  await new Promise((resolve) => server.listen(where, resolve));
  servers.push(server);
  return {server: where, commands};
}

/** @return {string} The command line host 15 starts mpv with: no stream. */
function thinHelperCommandLine(server) {
  return `"C:\\Program Files\\mpv\\mpv.exe" "--input-ipc-server=${server}" "--idle=once" ` +
    '"--force-window=immediate" "--no-terminal"';
}

describe('ipcServerOf', () => {
  it('reads the pipe from the command line host 15 starts mpv with', () => {
    expect(ipcServerOf(thinHelperCommandLine('\\\\.\\pipe\\faststream-mpv-7764c49c')))
        .toBe('\\\\.\\pipe\\faststream-mpv-7764c49c');
    expect(ipcServerOf('"mpv.exe" "--no-terminal" "https://cdn.example/v.m3u8"')).toBe(null);
  });
});

describe('the mpv windows an e2e spec started', () => {
  it('include one the thin helper started with no stream, known by its playlist', async () => {
    const mpv = await fakeMpv([`${Site}/clip5.mp4#fs-content=movie&fs-id=565b03d9bcd33b04`]);
    const processes = [{pid: 4100, startedAt: 2000, commandLine: thinHelperCommandLine(mpv.server)}];
    expect(await specMpvPids([Site], {processes, since: 1000})).toEqual([4100]);
    // asked, never told: nothing but get_property reaches an mpv
    expect(mpv.commands).toEqual([['get_property', 'playlist']]);
  });

  it('include one an older host started with the stream on its command line', async () => {
    const processes = [{pid: 7, startedAt: 0, commandLine: `"mpv.exe" "${Site}/clip5.mp4" "--referrer=${Site}/"`}];
    expect(await specMpvPids([Site], {processes, since: 1000})).toEqual([7]);
  });

  it('leave one that ran before the spec, though a test stream went into it', async () => {
    const mpv = await fakeMpv([`${Site}/clip5.mp4`]);
    const processes = [{pid: 8, startedAt: 500, commandLine: thinHelperCommandLine(mpv.server)}];
    expect(await specMpvPids([Site], {processes, since: 1000})).toEqual([]);
    expect(mpv.commands).toEqual([]);
  });

  it('leave one playing something else, one that does not answer, and one whose pipe is gone', async () => {
    const other = await fakeMpv(['https://www.example.com/movie.mkv']);
    const silent = await fakeMpv([`${Site}/clip5.mp4`], {silent: true});
    const processes = [
      {pid: 9, startedAt: 2000, commandLine: thinHelperCommandLine(other.server)},
      {pid: 10, startedAt: 2000, commandLine: thinHelperCommandLine(silent.server)},
      {pid: 11, startedAt: 2000, commandLine: thinHelperCommandLine(ipcPath())},
    ];
    expect(await specMpvPids([Site], {processes, since: 1000, timeoutMs: 200})).toEqual([]);
  });
});
