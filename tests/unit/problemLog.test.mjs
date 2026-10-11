import {beforeEach, describe, expect, it} from 'vitest';
import {ProblemKinds, clearProblems, issueUrl, readProblems, recordProblem} from '../../chrome/player/utils/ProblemLog.mjs';

// Sites where autoplay got stuck (his wish, 2026-10-11): noted per site and kind for the
// options page, which reports one as a GitHub issue the user checks first.

let store;
beforeEach(() => {
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key, callback) => setTimeout(() => callback({[key]: structuredClone(store[key])}), 0),
        set: (items, callback) => {
          Object.assign(store, structuredClone(items));
          setTimeout(callback, 0);
        },
      },
    },
  };
});

describe('ProblemLog', () => {
  it('notes a site and what went wrong, without the query, and counts it up', async () => {
    await recordProblem({url: 'https://s.to/serie/x/episode-5?token=secret', kind: ProblemKinds.NO_NEXT, mode: 'mpv'}, 1000);
    await recordProblem({url: 'https://s.to/serie/x/episode-6?token=other', kind: ProblemKinds.NO_NEXT, mode: 'player'}, 2000);
    expect(await readProblems()).toEqual([{id: 's.to no_next', protocol: 'https:', host: 's.to', path: '/serie/x/episode-6', kind: 'no_next',
      mode: 'player', count: 2, first: 1000, last: 2000}]);
    expect(JSON.stringify(store)).not.toContain('secret');
  });

  it('keeps another kind or another site apart, newest first', async () => {
    await recordProblem({url: 'https://a.test/1', kind: ProblemKinds.NO_NEXT, mode: 'player'}, 1);
    await recordProblem({url: 'https://a.test/2', kind: ProblemKinds.NO_STREAM, mode: 'player'}, 2);
    await recordProblem({url: 'https://b.test/1', kind: ProblemKinds.NO_NEXT, mode: 'player'}, 3);
    expect((await readProblems()).map((e) => e.id)).toEqual(['b.test no_next', 'a.test no_stream', 'a.test no_next']);
  });

  it('keeps the 50 newest, and nothing for an unknown kind or a page that is no web page', async () => {
    for (let i = 0; i < 55; i++) {
      await recordProblem({url: `https://site${i}.test/`, kind: ProblemKinds.NO_NEXT, mode: 'player'}, i);
    }
    const list = await readProblems();
    expect(list).toHaveLength(50);
    expect(list[0].host).toBe('site54.test');
    await clearProblems();
    await recordProblem({url: 'https://a.test/', kind: 'something', mode: 'player'});
    await recordProblem({url: 'about:blank', kind: ProblemKinds.NO_NEXT, mode: 'player'});
    await recordProblem({url: 'not a url', kind: ProblemKinds.NO_NEXT, mode: 'player'});
    expect(await readProblems()).toEqual([]);
  });

  it('builds a GitHub issue to check: the site, what happened, where, the versions', async () => {
    await recordProblem({url: 'https://s.to/serie/x/episode-5', kind: ProblemKinds.NO_STREAM, mode: 'mpv'}, Date.UTC(2026, 9, 11));
    const [entry] = await readProblems();
    const url = new URL(issueUrl(entry, {version: '1.3.82.90', browser: 'Firefox 157'}));
    expect(url.origin + url.pathname).toBe('https://github.com/Nawid3333/FastStream/issues/new');
    expect(url.searchParams.get('title')).toBe('Autoplay: s.to - next episode brought no video');
    const body = url.searchParams.get('body');
    expect(body).toContain('**Page:** https://s.to/serie/x/episode-5');
    expect(body).toContain('**Where:** MPV mode');
    expect(body).toContain('**FastStream:** 1.3.82.90');
    expect(body).toContain('GitHub issues are public');
  });

  it('keeps an http page http in the report', async () => {
    await recordProblem({url: 'http://old.test/watch/3', kind: ProblemKinds.NO_NEXT, mode: 'player'});
    const [entry] = await readProblems();
    const body = new URL(issueUrl(entry, {version: '1', browser: 'x'})).searchParams.get('body');
    expect(body).toContain('**Page:** http://old.test/watch/3');
  });
});
