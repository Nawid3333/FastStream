import {describe, expect, it, vi} from 'vitest';

// Keys that stopped or hid the video without a word. AltGr is Right Alt on a German keyboard and is pressed before the
// character it types ('[' is AltGr+8): its keydown hid the player (Right Alt's default) before '[' paused the downloads.
// The '-' key took away every downloader, and nothing added one back: playback's requests stopped too.

const listeners = {};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({
  DOMElements: {osd: {textContent: '', classList: {add() {}, remove() {}}}, playerContainer: {addEventListener() {}}},
}));
vi.stubGlobal('document', {addEventListener: (type, fn) => (listeners[type] ??= []).push(fn)});
vi.stubGlobal('navigator', {userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  platform: 'Win32'});

const {KeybindManager} = await import('../../chrome/player/ui/KeybindManager.mjs');

/**
 * A key event as Firefox on Windows reports it.
 * @param {Object} init
 * @return {Object}
 */
function key(init) {
  const altGraph = !!init.altGraph;
  return {target: {}, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {},
    stopPropagation() {}, getModifierState: (m) => m === 'AltGraph' && altGraph, ...init};
}

/** A manager over a stand-in client, with the actions it fired. */
function manager(downloaders = 3) {
  const client = {
    options: {},
    interfaceController: {toggleHide: vi.fn(), updateFragmentsLoaded: vi.fn()},
    downloadManager: {downloaders: Array.from({length: downloaders}), removeDownloader: vi.fn(),
      paused: false, pause: vi.fn(), resume: vi.fn()},
  };
  client.downloadManager.removeDownloader.mockImplementation(() => client.downloadManager.downloaders.pop());
  const keys = new KeybindManager(/** @type {any} */ (client));
  const fired = [];
  keys.on('keybind', (actions) => fired.push(...actions));
  return {keys, client, fired};
}

describe('AltGr', () => {
  const down = {key: 'AltGraph', code: 'AltRight', ctrlKey: true, altKey: true, altGraph: true};
  const control = {key: 'Control', code: 'ControlLeft', ctrlKey: true};

  it('listens for keys let go', () => {
    manager();
    expect(listeners.keyup?.length).toBeGreaterThan(0);
  });

  it('types the character it is held for, and does not hide the player first', () => {
    const {keys, fired} = manager();
    keys.onKeyDown(key(control));
    keys.onKeyDown(key(down));
    keys.onKeyDown(key({key: '[', code: 'Digit8', ctrlKey: true, altKey: true, altGraph: true}));
    keys.onKeyUp(key({key: '[', code: 'Digit8'}));
    keys.onKeyUp(key({key: 'AltGraph', code: 'AltRight'}));
    expect(fired).toEqual(['PauseDownloaders']);
  });

  it('hides the player when pressed and let go alone, even held long (Windows repeats it with Control)', () => {
    const {keys, fired, client} = manager();
    keys.onKeyDown(key(control));
    keys.onKeyDown(key(down));
    keys.onKeyDown(key({...control, repeat: true}));
    keys.onKeyDown(key({...down, repeat: true}));
    expect(fired).toEqual([]);
    keys.onKeyUp(key({key: 'AltGraph', code: 'AltRight'}));
    expect(fired).toEqual(['HidePlayer']);
    expect(client.interfaceController.toggleHide).toHaveBeenCalledTimes(1);
    // Let go once more (another listener's copy of the event): no second hide.
    keys.onKeyUp(key({key: 'AltGraph', code: 'AltRight'}));
    expect(fired).toEqual(['HidePlayer']);
  });

  it('leaves Right Alt where it is no AltGr (a US keyboard) as it was: it hides on the press', () => {
    const {keys, fired} = manager();
    keys.onKeyDown(key({key: 'Alt', code: 'AltRight', altKey: true}));
    expect(fired).toEqual(['HidePlayer']);
  });

  it('does nothing when typed into a text field', () => {
    const {keys, fired} = manager();
    const field = {tagName: 'INPUT', type: 'text', isContentEditable: false};
    keys.onKeyDown(key({...down, target: field}));
    keys.onKeyUp(key({key: 'AltGraph', code: 'AltRight', target: field}));
    expect(fired).toEqual([]);
  });
});

describe('the remove-downloader key', () => {
  it('keeps the last downloader', () => {
    const {keys, client} = manager(3);
    for (let i = 0; i < 5; i++) keys.onKeyDown(key({key: '-', code: 'Minus'}));
    expect(client.downloadManager.downloaders).toHaveLength(1);
    expect(client.downloadManager.removeDownloader).toHaveBeenCalledTimes(2);
  });
});
