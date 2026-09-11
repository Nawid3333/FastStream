import {describe, expect, it} from 'vitest';
import {loadIntoExisting} from '../../native-host/faststream-mpv-host.mjs';

// loadIntoExisting decides whether the "reuse the window we already own"
// path actually worked, from the IPC replies mpvIpcRequest collects. That
// function is injected here instead of hitting a real named pipe: it is
// Windows-only, and this suite runs on Linux CI too (see ci.yml).
//
// mpvIpcRequest can resolve {ok: true} on its own 1.5s timeout as soon as
// *any* reply has arrived -- a live-but-slow pipe still counts as "ours" --
// which means the loadfile reply specifically can be missing even though
// result.ok is true. Before the fix, a missing loadReply skipped the error
// check entirely and fell through to {ok: true, pid: undefined}: success
// was reported without ever confirming the video loaded, so the caller
// never started a fresh instance to actually play it.

const message = {url: 'https://example.com/video.m3u8'};
const headerFields = ['Referer: https://example.com/'];
const title = 'example.com';

describe('loadIntoExisting', () => {
  it('succeeds when every reply, including loadfile, comes back', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: 1},
        {request_id: 2},
        {request_id: commands.length - 1, error: 'success'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: true, pid: 4242});
  });

  it('fails when the pipe answers but loadfile is refused', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: 1},
        {request_id: 2},
        {request_id: commands.length - 1, error: 'property unavailable'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('fails, not phantom-succeeds, when the loadfile reply never arrives', async () => {
    // Simulates mpvIpcRequest's own timeout firing after only the two
    // set_property replies came back -- ok:true, but no reply for loadfile
    // or get_property pid yet. This is the regression case: it must not be
    // reported as success.
    const ipcRequest = async () => ({
      ok: true,
      replies: [
        {request_id: 1},
        {request_id: 2},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('fails when no instance of ours answers at all', async () => {
    const ipcRequest = async () => ({ok: false, error: 'no mpv ipc'});
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('keeps request ids aligned when the fullscreen command is inserted', async () => {
    const ipcRequest = async (commands) => {
      // fullscreen adds a 5th command, shifting loadfile/get_property to
      // request_id 4 and 5 -- catches an off-by-one if the indices were
      // ever hardcoded instead of derived from commands.length.
      expect(commands).toHaveLength(5);
      return {
        ok: true,
        replies: [
          {request_id: 1},
          {request_id: 2},
          {request_id: 3},
          {request_id: 4, error: 'success'},
          {request_id: 5, data: 777},
        ],
      };
    };
    const result = await loadIntoExisting(
        {...message, fullscreen: true}, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: true, pid: 777});
  });
});
