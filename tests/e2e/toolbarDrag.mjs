// Drags a tool of the player's control bar the way a mouse drag reaches the page in Firefox,
// and reads the bar's order: for specs/toolbar-reorder.e2e.mjs.
//
// The bar is three sortablejs lists sharing one group (ui/ToolManager.mjs), whose onEnd saves
// the order as `toolSettings` (localStorage in the web build, storage.local in the extension);
// the next player sorts the tools by it.
//
// In desktop Firefox sortablejs uses the browser's own drag and drop (HTML5 dragstart,
// dragover, drop), and Firefox's WebDriver starts such a drag but cannot end one (bug
// 1515879). Measured in Firefox 158 on CI's Linux and Windows (run 39477097683): a pointer
// drag through WebDriver's actions gave the page pointerdown, mousedown, pointermove,
// dragstart, pointercancel, then dragenter, dragover and dragleave, and sortablejs moved the
// tool; letting go gave no drop, no dragend and no mouseup, so the drag never ended and
// nothing was saved. Where the tool had got to depended on the pointer's path, too. So each
// step of a mouse drag is dispatched in the page in that order, at the points on screen, to
// what is under them: the press on the tool, a move past the drag threshold, dragstart on the
// tool once the press has made it draggable, pointercancel, dragenter and dragover at the
// place on the target tool (dragleave where the pointer was), then, letting go, drop there and
// dragend on the tool. sortablejs takes them through its own listeners. The player stops every
// dragover and drop at .mainplayer (InterfaceController, SaveManager's file drop), so
// sortablejs ends a toolbar drag on dragend, never on its document-level drop listener.
//
// Not covered: Firefox turning the mouse's moves into those events, the many dragovers of a
// real pointer's path, and a real press's own effects on the tool dragged (focus, :hover).
import {browser, expect} from '@wdio/globals';

/**
 * @typedef {{left: string[], right: string[], extra: string[]}} ToolOrder
 * The tools of the bar's left list, right list and "more" menu, by their data-tool.
 */

/**
 * Opens the player with no source and waits for its saved options. The tool order is read
 * from localStorage within microtasks of the client's setup, before main.mjs applies the
 * other options and sets optionsApplied.
 * @return {Promise<void>}
 */
export async function openPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
}

/**
 * Opens the player with no tool order saved: the default one.
 * @return {Promise<void>}
 */
export async function openPlayerWithDefaultOrder() {
  await openPlayer();
  await browser.execute(() => localStorage.removeItem('toolSettings'));
  await openPlayer();
}

/**
 * The tools in each of the bar's lists, in the order the page has them (hidden ones too).
 * @return {Promise<ToolOrder>}
 */
export function shownOrder() {
  return browser.execute(() => {
    const read = (selector) => Array.from(document.querySelector(selector).children,
        (el) => el.dataset.tool ?? `<${el.className}>`);
    return {
      left: read('.mainplayer .tools_container_left'),
      right: read('.mainplayer .fluid_controls_right'),
      extra: read('.mainplayer .fluid_controls_extra_tools'),
    };
  });
}

/**
 * The order saved in toolSettings, as the lists the next player builds from it.
 * @return {Promise<ToolOrder|null>} null when none is saved.
 */
export async function savedOrder() {
  const saved = await browser.execute(() => localStorage.getItem('toolSettings'));
  if (!saved) return null;
  const order = {left: [], right: [], extra: []};
  const tools = Object.entries(JSON.parse(saved)).sort((a, b) => a[1].priority - b[1].priority);
  for (const [tool, {location}] of tools) {
    (order[location] ??= []).push(tool);
  }
  return order;
}

/**
 * The lists with one tool moved next to another.
 * @param {ToolOrder} order - The lists before.
 * @param {string} tool - The tool moved.
 * @param {string} target - The tool it goes next to.
 * @param {'before'|'after'} side - Which side of the target.
 * @return {ToolOrder}
 */
export function withMove(order, tool, target, side) {
  const out = {};
  for (const [name, list] of Object.entries(order)) {
    out[name] = list.filter((t) => t !== tool);
    const at = out[name].indexOf(target);
    if (at >= 0) out[name].splice(side === 'before' ? at : at + 1, 0, tool);
  }
  return out;
}

/** @return {Promise<boolean>} Whether ToolManager is between sortablejs's onStart and onEnd. */
function dragging() {
  return browser.execute(() => window.fastStream.interfaceController.toolManager.userIsReordering);
}

/**
 * Drags one tool onto another the way a mouse drag reaches the page in Firefox (see the top
 * of the file), and lets go there.
 * @param {string} tool - The tool dragged (its data-tool).
 * @param {string} target - The tool it is let go on.
 * @param {number} along - Where on the target: 0 its left edge, 1 its right edge. sortablejs
 *     puts a tool from the same list before or after the target by the way it came, and one
 *     from another list on the side of the target's middle the pointer is on.
 * @return {Promise<void>}
 */
export async function dragTool(tool, target, along) {
  const pressed = await browser.execute((tool) => {
    const el = document.querySelector(`.mainplayer [data-tool="${tool}"]`);
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const under = document.elementFromPoint(x, y);
    if (!under || !el.contains(under)) {
      return `the middle of ${tool} is covered by ${under ? under.outerHTML.slice(0, 120) : 'nothing'}`;
    }
    const mouse = {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1};
    const pointer = {pointerId: 1, pointerType: 'mouse', isPrimary: true};
    under.dispatchEvent(new PointerEvent('pointerdown', {...mouse, ...pointer}));
    under.dispatchEvent(new MouseEvent('mousedown', mouse));
    // Firefox starts a drag from a press only on a draggable element: sortablejs makes the
    // tool one on the press.
    if (!el.draggable) {
      return `the press left ${tool} not draggable, so Firefox would start no drag`;
    }
    // A few pixels on (Firefox's drag threshold), the drag starts, and the pointer's own
    // events end with a pointercancel.
    const moved = {...mouse, clientX: x + 5};
    under.dispatchEvent(new PointerEvent('pointermove', {...moved, ...pointer}));
    under.dispatchEvent(new MouseEvent('mousemove', moved));
    const dataTransfer = new DataTransfer();
    window.__toolDrag = {el, dataTransfer, under};
    el.dispatchEvent(new DragEvent('dragstart', {...moved, dataTransfer}));
    under.dispatchEvent(new PointerEvent('pointercancel', {...moved, ...pointer, buttons: 0, cancelable: false}));
    return null;
  }, tool);
  if (pressed) throw new Error(pressed);

  // sortablejs starts the drag a task after dragstart, and takes no dragover before.
  await browser.waitUntil(dragging,
      {timeout: 5000, timeoutMsg: `sortablejs never started the drag of ${tool} (ToolManager's onStart)`});

  const over = await browser.execute((target, along) => {
    const el = document.querySelector(`.mainplayer [data-tool="${target}"]`);
    const box = el.getBoundingClientRect();
    const x = box.left + box.width * along;
    const y = box.top + box.height / 2;
    const under = document.elementFromPoint(x, y);
    if (!under || !el.contains(under)) {
      return `the place on ${target} is covered by ${under ? under.outerHTML.slice(0, 120) : 'nothing'}`;
    }
    const drag = {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
      buttons: 1, dataTransfer: window.__toolDrag.dataTransfer};
    under.dispatchEvent(new DragEvent('dragenter', drag));
    window.__toolDrag.under.dispatchEvent(new DragEvent('dragleave', {...drag, cancelable: false}));
    under.dispatchEvent(new DragEvent('dragover', drag));
    Object.assign(window.__toolDrag, {x, y, under});
    return null;
  }, target, along);
  if (over) throw new Error(over);

  // Let go where the pointer is: drop on what is under it now, then dragend on the tool.
  await browser.execute(() => {
    const {el, dataTransfer, x, y} = window.__toolDrag;
    const drag = {bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, dataTransfer};
    (document.elementFromPoint(x, y) ?? document.documentElement).dispatchEvent(new DragEvent('drop', drag));
    el.dispatchEvent(new DragEvent('dragend', drag));
  });
  await browser.waitUntil(async () => !(await dragging()),
      {timeout: 5000, timeoutMsg: `sortablejs never ended the drag of ${tool} (ToolManager's onEnd)`});
}

/**
 * Holds the mouse button down on a tool until ToolManager's long press (800 ms) has opened
 * the reorder mode, which shows the "more" menu's tools, hidden ones too. A real press.
 * @param {string} tool - The tool pressed.
 * @return {Promise<void>}
 */
export async function openReorderMode(tool) {
  const id = 'toolbar-mouse';
  const el = await browser.$(`.mainplayer [data-tool="${tool}"]`);
  await browser.action('pointer', {id}).move({origin: el}).down().perform(true);
  try {
    await browser.waitUntil(async () => browser.execute(() => window.fastStream.interfaceController.toolManager.specialReorderModeEnabled),
        {timeout: 10000, timeoutMsg: 'a long press on a tool never opened the reorder mode'});
  } finally {
    // Let go, and take the pointer off the bar, where it would show a tooltip.
    await browser.action('pointer', {id}).up().move({origin: 'viewport', x: 1, y: 1}).perform();
  }
}

/**
 * Checks the bar shows the order and has saved it, and that the next player shows it too.
 * @param {ToolOrder} expected - The order.
 * @return {Promise<void>}
 */
export async function expectOrderKept(expected) {
  expect(await shownOrder()).toEqual(expected);
  expect(await savedOrder()).toEqual(expected);
  await openPlayer();
  expect(await shownOrder()).toEqual(expected);
}
