// @ts-check

/**
 * The page's right-click menu: FastStream and MPV for the page and its video, as the toolbar
 * button and the MPV key switch them, and a link opened in a new tab with FastStream or MPV
 * already on (his wish, 2026-10-24). Firefox's menus API: the items are made once a start of
 * the background, and named for the tab they are shown in just before they show (onShown,
 * refresh), so "Play in FastStream" reads "Turn FastStream off" where it plays.
 */

export const MenuIds = Object.freeze({
  PLAYER: 'faststream-player',
  MPV: 'faststream-mpv',
  LINK_PLAYER: 'faststream-link-player',
  LINK_MPV: 'faststream-link-mpv',
});

/** Web pages only: the player's own pages and other extensions' have nothing to switch. */
const DOCUMENTS = ['http://*/*', 'https://*/*', 'file:///*'];
/** Firefox's menus API (chrome.contextMenus in the types), with its own refresh(). */
/** @typedef {typeof chrome.contextMenus & {refresh?: () => Promise<void>}} Menus */

/** @type {any[]} the contexts' names, as Firefox takes them (an enum in the types). */
const PAGE_CONTEXTS = ['page', 'frame', 'video', 'audio'];

/**
 * @typedef {Object} MenuState
 * @property {boolean} isOn - FastStream is on for the tab.
 * @property {boolean} isMpv - It sends the tab's video to MPV.
 * @property {boolean} mpvMode - MPV mode is enabled in the options.
 */

/**
 * Each item's title and whether it shows, for a tab in this state.
 * @param {MenuState} state
 * @param {(key: string) => string} getMessage
 * @return {Array<{id: string, title: string, visible: boolean}>}
 */
export function menuItems(state, getMessage) {
  return [
    {id: MenuIds.PLAYER, visible: true,
      title: getMessage(state.isOn && !state.isMpv ? 'menu_faststream_off' : 'menu_play_in_faststream')},
    {id: MenuIds.MPV, visible: state.mpvMode,
      title: getMessage(state.isOn && state.isMpv ? 'menu_mpv_off' : 'menu_play_in_mpv')},
    {id: MenuIds.LINK_PLAYER, visible: true, title: getMessage('menu_link_in_faststream')},
    {id: MenuIds.LINK_MPV, visible: state.mpvMode, title: getMessage('menu_link_in_mpv')},
  ];
}

/**
 * Makes the items, for a tab FastStream is off in. Those of a start before go first: an
 * event page's items outlive it, and an id made twice is an error.
 * @param {Menus} menus
 * @param {(key: string) => string} getMessage
 * @param {boolean} mpvMode
 * @return {Promise<void>}
 */
export async function createMenus(menus, getMessage, mpvMode) {
  await menus.removeAll();
  for (const item of menuItems({isOn: false, isMpv: false, mpvMode}, getMessage)) {
    const link = item.id === MenuIds.LINK_PLAYER || item.id === MenuIds.LINK_MPV;
    menus.create({
      id: item.id,
      title: item.title,
      visible: item.visible,
      contexts: /** @type {any} */ (link ? ['link'] : PAGE_CONTEXTS),
      documentUrlPatterns: DOCUMENTS,
      // A link's item: to a web page only, not a javascript: or a mailto: link.
      ...(link ? {targetUrlPatterns: ['http://*/*', 'https://*/*']} : {}),
    });
  }
}

/**
 * Names the items for the tab they show in, and shows them so. Each item on its own: one
 * Firefox refuses leaves the others named, and the menu is shown again either way.
 * @param {Menus} menus
 * @param {MenuState} state
 * @param {(key: string) => string} getMessage
 * @return {Promise<void>}
 */
export async function updateMenus(menus, state, getMessage) {
  for (const item of menuItems(state, getMessage)) {
    try {
      await menus.update(item.id, {title: item.title, visible: item.visible});
    } catch (e) {
      console.error('The right-click menu\'s item was not updated', item.id, e);
    }
  }
  // Firefox's own: a menu already open shows the new titles.
  await menus.refresh?.();
}

/**
 * The link a link item opens: a web page's, never another scheme.
 * @param {string|undefined} url
 * @return {?string}
 */
export function linkTarget(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch (e) {
    return null;
  }
}
