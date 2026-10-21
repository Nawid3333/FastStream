import {beforeEach, describe, expect, it, vi} from 'vitest';

// The player page is web-accessible: any page could open it in a tab with an address of its
// own, and the player took that address's made-up headers and mode. Only the redirect rule's
// address carries the key now (AddressKey.mjs), and the player trusts no other.

const MODULE = '../../chrome/player/utils/AddressKey.mjs';
let local;

beforeEach(() => {
  vi.resetModules();
  local = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key, callback) => callback({[key]: local[key]}),
        set: (items, callback) => {
          Object.assign(local, items);
          callback();
        },
      },
    },
  });
});

describe('AddressKey', () => {
  it('makes one key per install, kept in the extension\'s storage', async () => {
    const {getAddressKey} = await import(MODULE);
    const [first, second] = await Promise.all([getAddressKey(), getAddressKey()]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(local.playerAddressKey).toBe(first);
    // A background started again keeps it: a tab restored with the old address still counts.
    vi.resetModules();
    expect(await (await import(MODULE)).getAddressKey()).toBe(first);
  });

  it('trusts only an address that carries the key', async () => {
    const {getAddressKey, isAddressFromRedirect} = await import(MODULE);
    const key = await getAddressKey();
    expect(await isAddressFromRedirect(`?address=${key}`)).toBe(true);
    expect(await isAddressFromRedirect(`?opener=1&address=${key}`)).toBe(true);
    expect(await isAddressFromRedirect('')).toBe(false);
    expect(await isAddressFromRedirect('?address=')).toBe(false);
    expect(await isAddressFromRedirect('?address=made-up')).toBe(false);
  });

  it('trusts no address before a key was made', async () => {
    const {isAddressFromRedirect} = await import(MODULE);
    expect(await isAddressFromRedirect('?address=undefined')).toBe(false);
  });
});
