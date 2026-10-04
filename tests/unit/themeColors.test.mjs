import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

// The player's 11 themes are blocks of the same CSS variables in colors.css. Three colours
// were written into the page and the CSS instead (#277): the muted-speaker icon and the big
// play circle kept the dark themes' colours on the light ones, and the mixer's "configured"
// colour had !important, which no theme could override.

const read = (file) => fs.readFileSync(new URL(`../../chrome/player/${file}`, import.meta.url), 'utf8');
const colorsCss = read('assets/fluidplayer/css/colors.css');
const playerCss = read('assets/fluidplayer/css/fluidplayer.css');
const playerHtml = read('index.html');

/**
 * @return {Map<string, Map<string, string>>} Each theme's variables and their values.
 */
function themes() {
  const result = new Map();
  for (const match of colorsCss.matchAll(/body\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
    const variables = new Map();
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      variables.set(declaration[1], declaration[2].trim());
    }
    result.set(match[1], variables);
  }
  return result;
}

const LIGHT_THEMES = ['arctic', 'sunset', 'desert', 'mint'];

describe('theme colours', () => {
  it('has the 11 themes, each with the same variables', () => {
    const all = themes();
    expect([...all.keys()]).toHaveLength(11);
    const names = [...all.get('default').keys()].sort();
    for (const [theme, variables] of all) {
      expect([...variables.keys()].sort(), theme).toEqual(names);
    }
  });

  it('defines in every theme each variable the player\'s CSS reads', () => {
    const own = new Set([...playerCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...playerCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    for (const [theme, variables] of themes()) {
      const missing = [...used].filter((name) => !variables.has(name) && !own.has(name));
      expect(missing, theme).toEqual([]);
    }
  });

  it('gives the muted icon and the big play circle colours of their own on the light themes', () => {
    const all = themes();
    const dark = all.get('default');
    for (const theme of LIGHT_THEMES) {
      const variables = all.get(theme);
      expect(variables.get('--mute-icon-color'), theme).not.toBe(dark.get('--mute-icon-color'));
      expect(variables.get('--initial-play-background-color'), theme)
          .not.toBe(dark.get('--initial-play-background-color'));
    }
    expect(playerCss).toMatch(/\.fluid_control_mute \.speaker-muted \{[^}]*color: var\(--mute-icon-color\)/);
    expect(playerCss).toMatch(/\.fluid_initial_play \{[^}]*background-color: var\(--initial-play-background-color\)/);
  });

  it('leaves the page no colour of its own that would beat a theme', () => {
    // An inline colour beats every stylesheet rule; one read from a theme variable is fine.
    const fixed = [...playerHtml.matchAll(/style="([^"]*)"/g)].map((m) => m[1])
        .filter((style) => /(^|;)\s*(background-)?color\s*:(?!\s*var\()/.test(style));
    expect(fixed).toEqual([]);
  });

  it('lets a theme set the mixer\'s "configured" colour', () => {
    const rule = playerCss.match(/\.mixer_channel_dyn\.configured \{([^}]*)\}/);
    expect(rule[1]).toContain('var(--mixer-configured-color)');
    expect(rule[1]).not.toContain('!important');
  });
});
