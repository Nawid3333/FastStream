// @ts-check
// Window and document listeners that outlive document.open(), which erases them (docs/notes/player.md, "Frames with
// no address of their own"). The first content script: the others use it.
// eslint-disable-next-line no-unused-vars
const PageListeners = (() => {
  /** @type {Array<{target: EventTarget, type: string, listener: EventListener, options: (boolean|AddEventListenerOptions|undefined)}>} */
  const added = [];
  let root = document.documentElement;

  new MutationObserver(() => {
    if (document.documentElement === root) return;
    root = document.documentElement;
    for (const {target, type, listener, options} of added) target.addEventListener(type, listener, options);
  }).observe(document, {childList: true});

  return {
    /**
     * @template {string} K
     * @param {Window|Document} target
     * @param {K} type
     * @param {(event: K extends keyof DocumentEventMap ? DocumentEventMap[K] :
     *   K extends keyof WindowEventMap ? WindowEventMap[K] : Event) => void} listener
     * @param {boolean|AddEventListenerOptions} [options]
     */
    add(target, type, listener, options) {
      const asListener = /** @type {EventListener} */ (listener);
      target.addEventListener(type, asListener, options);
      added.push({target, type, listener: asListener, options});
    },
  };
})();
