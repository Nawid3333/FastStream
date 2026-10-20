// The control bar's rearranging: a tool dragged along the bar, from one side of it to the
// other, and into the "more" menu, saved, and in the same place in the next player.
//
// sortablejs does the dragging (ui/ToolManager.mjs). It ships in the extension as npm
// publishes it (tools/sync-vendor.mjs) and moves with Dependabot's weekly
// shipped-minor-and-patch group, and no other test drags a tool: this is what tells a release
// that breaks the rearranging from one that does not. How the drag is made, and what that
// leaves out: ../toolbarDrag.mjs.
import {expect} from '@wdio/globals';
import {dragTool, expectOrderKept, openPlayerWithDefaultOrder, openReorderMode, savedOrder, shownOrder, withMove}
  from '../toolbarDrag.mjs';

describe('The control bar rearranged by dragging (sortablejs)', function() {
  it('moves a tool along the bar, and the next player has it there', async function() {
    await openPlayerWithDefaultOrder();
    const before = await shownOrder();
    expect(await savedOrder()).toBe(null);
    expect(before.right.indexOf('settings')).toBeGreaterThan(before.right.indexOf('sources'));

    // Back along its own list: sortablejs puts it before the tool it is let go on.
    await dragTool('settings', 'sources', 0.5);
    await expectOrderKept(withMove(before, 'settings', 'sources', 'before'));
  });

  it('moves a tool from one side of the bar to the other', async function() {
    await openPlayerWithDefaultOrder();
    const before = await shownOrder();
    expect(before.right).toContain('subtitles');
    expect(before.left).toContain('volume');

    // Into the other list, on the left half of the volume button: before it.
    await dragTool('subtitles', 'volume', 0.25);
    await expectOrderKept(withMove(before, 'subtitles', 'volume', 'before'));
  });

  it('moves a tool into the "more" menu in the reorder mode a long press opens', async function() {
    await openPlayerWithDefaultOrder();
    const before = await shownOrder();
    expect(before.extra).toContain('pip');

    await openReorderMode('playpause');
    await dragTool('playrate', 'pip', 0.25);
    await expectOrderKept(withMove(before, 'playrate', 'pip', 'before'));
  });
});
