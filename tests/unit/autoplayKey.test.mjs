import {describe, expect, it, vi} from 'vitest';

// Shift+A switches autoplay of the next video for this tab, as the autoplay switch does, and says the new state on the
// video (the switch's own look changes only while the controls show).

const osd = {textContent: '', classList: {add() {}, remove() {}}};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {osd, playerContainer: {addEventListener() {}}}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key) => ({mpv_autoplay_title: 'Autoplay', mpv_autoplay_on: 'on', mpv_autoplay_off: 'off'})[key] ?? key},
}));
vi.stubGlobal('document', {addEventListener() {}});

const {KeybindManager} = await import('../../chrome/player/ui/KeybindManager.mjs');

describe('the autoplay key', () => {
  it('switches autoplay on and off on Shift+A and says so on the video', () => {
    const client = {options: {autoplayNext: false}, interfaceController: {}};
    client.interfaceController.toggleAutoplayNext = vi.fn(() => {
      client.options.autoplayNext = !client.options.autoplayNext;
    });
    const keys = new KeybindManager(/** @type {any} */ (client));
    const shown = vi.spyOn(keys.osd, 'show').mockImplementation(() => {});
    const press = () => keys.onKeyDown(/** @type {any} */ ({key: 'A', code: 'KeyA', shiftKey: true, ctrlKey: false,
      altKey: false, metaKey: false, target: {}, getModifierState: () => false, preventDefault() {}, stopPropagation() {}}));
    press();
    expect(client.options.autoplayNext).toBe(true);
    expect(shown).toHaveBeenLastCalledWith('Autoplay: on');
    press();
    expect(client.options.autoplayNext).toBe(false);
    expect(shown).toHaveBeenLastCalledWith('Autoplay: off');
    expect(client.interfaceController.toggleAutoplayNext).toHaveBeenCalledTimes(2);
  });
});
