// @ts-check

/** Firefox's menus API: items are made once a start, and named for their tab just before they show. */

export const MenuIds = Object.freeze({
  PLAYER: 'faststream-player',
  MPV: 'faststream-mpv',
  LINK_PLAYER: 'faststream-link-player',
  LINK_MPV: 'faststream-link-mpv',
});

const DOCUMENTS = ['http://*/*', 'https://*/*', 'file:///*'];
/** @typedef {typeof chrome.contextMenus & {refresh?: () => Promise<void>}} Menus */

/** @type {any[]} */
const PAGE_CONTEXTS = ['page', 'frame', 'video', 'audio'];

/**
 * @typedef {Object} MenuState
 * @property {boolean} isOn
 * @property {boolean} isMpv
 * @property {boolean} mpvMode
 */

/**
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
 * Items of an earlier start go first: an event page's items outlive it, and an id made twice is an error.
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
      ...(link ? {targetUrlPatterns: ['http://*/*', 'https://*/*']} : {}),
    });
  }
}

/**
 * Each item on its own: one Firefox refuses leaves the others named.
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
  // Firefox only: a menu already open shows the new titles.
  await menus.refresh?.();
}

/**
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
