import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {stripLocaleMessageBlock} from '../../tools/sync-vendor.mjs';

// sweetalert2 once shipped a block that, for a Russian-language browser on a .ru/.su/.by
// host, blocked the page's pointer events and looped remote audio. sync-vendor removes it by
// its host test; when that marker was absent it returned the source unchanged, so a block
// reworded past the marker would have shipped and nothing would have said so. 11.26.25 has
// no such block, which made the transform a silent no-op.

const block = [
  '  if (typeof window !== \'undefined\' && /^ru\\b/.test(navigator.language) && location.host.match(/\\.(ru|su|by|xn--p1ai)$/)) {',
  '    setTimeout(() => {',
  '      document.body.style.pointerEvents = \'none\';',
  '      const anthem = document.createElement(\'audio\');',
  '      anthem.src = \'https://flag-gimn.ru/wp-content/uploads/2021/09/Ukraina.mp3\';',
  '      document.body.appendChild(anthem);',
  '    }, 500);',
  '  }',
].join('\n');

describe('stripLocaleMessageBlock', () => {
  it('removes the block in the form sweetalert2 shipped it', () => {
    const source = `const a = 1;\n${block}\nconst b = 2;\n`;
    expect(stripLocaleMessageBlock(source)).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('fails on a block worded so the marker misses it', () => {
    const reworded = block.replace('typeof window !== \'undefined\' && ', '');
    expect(() => stripLocaleMessageBlock(`const a = 1;\n${reworded}\n`)).toThrow(/pointerEvents/);
    // Each thing the block does is enough on its own.
    expect(() => stripLocaleMessageBlock('const s = document.createElement(\'audio\');\n')).toThrow(/audio/);
    expect(() => stripLocaleMessageBlock('const u = \'https://flag-gimn.ru/x.mp3\';\n')).toThrow(/flag-gimn/);
  });

  it('passes the release package.json pins, unchanged', () => {
    const dist = fs.readFileSync(new URL('../../node_modules/sweetalert2/dist/sweetalert2.js', import.meta.url), 'utf8');
    expect(stripLocaleMessageBlock(dist)).toBe(dist);
  });
});
