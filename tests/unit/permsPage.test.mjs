import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// background.mjs opens perms.html whenever a permission is missing, so it is the page that
// tells a user what each permission is for. It explained 5 of the 8 (nothing on
// nativeMessaging, downloads or cookies) and sent the reader to upstream's code at an old
// commit, for line ranges this fork's files do not have.

const chromeDir = path.resolve(import.meta.dirname, '../../chrome');
const html = fs.readFileSync(path.join(chromeDir, 'perms.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8'));

describe('The permissions page', () => {
  it('explains every permission the manifest asks for', () => {
    const explained = [...html.matchAll(/data-perm="([^"]+)"/g)].map((match) => match[1]);
    const asked = [...manifest.permissions];
    if (manifest.host_permissions.includes('<all_urls>')) asked.push('all-urls');
    expect(asked.length).toBeGreaterThanOrEqual(8);
    expect(asked.filter((permission) => !explained.includes(permission))).toEqual([]);
    // perms.mjs grants on a click whatever a row names, so a row must name a real one.
    expect(explained.filter((permission) => !asked.includes(permission))).toEqual([]);
  });

  it('gives every permission a heading and a description', () => {
    const headings = [...html.matchAll(/data-i18n="(perms_page_breakdown_perm\d+)h"/g)].map((match) => match[1]);
    const descriptions = [...html.matchAll(/data-i18n="(perms_page_breakdown_perm\d+)d"/g)].map((match) => match[1]);
    expect(headings.length).toBe([...html.matchAll(/data-perm="/g)].length);
    expect(descriptions).toEqual(headings);
  });

  it('links to this repository\'s code, not to upstream\'s', () => {
    const links = [...html.matchAll(/href="(https:\/\/github\.com\/[^"]+)"/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter((link) => !link.startsWith('https://github.com/Nawid3333/FastStream'))).toEqual([]);
    // Line numbers drift with every change; the files do not.
    expect(links.filter((link) => link.includes('#L'))).toEqual([]);
  });
});
