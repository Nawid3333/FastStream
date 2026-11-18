// @ts-check
// The next or previous episode of a series page, for content.js. Pure: no DOM.
// eslint-disable-next-line no-unused-vars
const EpisodeLinks = (() => {
  // "Next episode" phrases: lower case, single spaces.
  const EPISODE = {
    next: ['next episode', 'next ep', 'nächste folge', 'nächste episode', 'épisode suivant',
      'épisode suivante', 'episode suivant', 'siguiente episodio', 'episodio siguiente', 'próximo episódio',
      'próximo episodio', 'proximo episodio', 'prossimo episodio', 'episodio successivo', 'volgende aflevering',
      'volgende episode', 'następny odcinek', 'kolejny odcinek', 'следующая серия', 'следующий эпизод',
      'sonraki bölüm', '次のエピソード', '次の話', '次話', '下一集', '下一話', '下一话', '다음 화', '다음화',
      '다음 에피소드', 'episode berikutnya', 'episode selanjutnya', 'episod seterusnya'],
    previous: ['previous episode', 'prev episode', 'previous ep', 'prev ep', 'vorherige folge',
      'vorherige episode', 'épisode précédent', 'episode precedent', 'episodio anterior', 'episódio anterior',
      'episodio precedente', 'vorige aflevering', 'poprzedni odcinek', 'предыдущая серия', 'предыдущий эпизод',
      'önceki bölüm', '前のエピソード', '前の話', '前話', '上一集', '上一話', '上一话', '이전 화', '이전화',
      '이전 에피소드', 'episode sebelumnya', 'episod sebelumnya'],
  };
  // A bare word, which a gallery or a pagination uses too: taken only when nothing better is.
  const WORD = {
    next: ['next', 'weiter', 'nächste', 'suivant', 'siguiente', 'próximo', 'proximo', 'prossimo',
      'successivo', 'volgende', 'następny', 'następna', 'следующая', 'следующий', 'далее', 'sonraki', '次',
      '次へ', '下一个', '下一個', '다음', 'berikutnya', 'selanjutnya', 'seterusnya'],
    previous: ['previous', 'prev', 'zurück', 'vorherige', 'précédent', 'precedent', 'anterior', 'precedente',
      'vorige', 'poprzedni', 'poprzednia', 'предыдущая', 'предыдущий', 'назад', 'önceki', '前', '前へ',
      '上一个', '上一個', '이전', 'sebelumnya'],
  };
  // A page of a list, not an episode: "next page", "nächste Seite", 下一页...
  const PAGE = /\b(page|seite|página|pagina|pagine|strona|stron|sayfa|halaman)\b|страниц|ページ|页|頁|페이지/i;
  // Stripped by a loop, not a `[…]+$` regex: that is quadratic in a long run of marks.
  const MARKS = new Set(' «»‹›<>←→⟨⟩❮❯|·•…:-–—');

  /**
   * @param {string} text
   * @return {string} It without the marks at either end.
   */
  function stripMarks(text) {
    let start = 0;
    let end = text.length;
    while (start < end && MARKS.has(text[start])) start++;
    while (end > start && MARKS.has(text[end - 1])) end--;
    return text.slice(start, end);
  }

  /**
   * Lower case, single spaces, no arrows at either end; Turkish i's as a plain i in every locale.
   * @param {*} text
   * @return {string}
   */
  function normalize(text) {
    return stripMarks(String(text || '').replace(/\s+/g, ' ')).trim().toLowerCase()
        .replace(/i̇/g, 'i').replace(/ı/g, 'i');
  }

  /**
   * 2 an episode phrase ("Nächste Folge"), 1 a bare word ("weiter"), 0 neither or a list's page.
   * @param {*} text - Its text, aria-label or title.
   * @param {boolean} isNext
   * @return {number}
   */
  function phraseScore(text, isNext) {
    const words = normalize(text);
    if (!words || words.length > 80 || PAGE.test(words)) return 0;
    const direction = isNext ? 'next' : 'previous';
    for (const phrase of EPISODE[direction]) {
      if (words === phrase) return 2;
      // "Next episode 13", "Nächste Folge: Der Anfang": the phrase, then no letter of a word.
      if (words.startsWith(phrase) && !/^[\p{L}]/u.test(words.slice(phrase.length))) return 2;
    }
    return WORD[direction].includes(words) ? 1 : 0;
  }

  /**
   * The path decoded ("épisode" comes percent-encoded); reserved characters (%2F) stay encoded.
   * @param {URL} url
   * @return {string}
   */
  function readablePath(url) {
    try {
      return decodeURI(url.pathname);
    } catch (e) {
      return url.pathname;
    }
  }

  /**
   * Where the digit run at `at` in the readable path is in the raw path.
   * @param {string} raw - url.pathname.
   * @param {string} path - readablePath of it.
   * @param {number} at
   * @return {number} -1 where it cannot be told.
   */
  function rawIndex(raw, path, at) {
    if (raw === path) return at;
    /** @param {string} text */
    const runs = (text) => [...text.replace(/%[0-9a-f]{2}/gi, '%__').matchAll(/\d+/g)];
    const ordinal = runs(path).findIndex((m) => m.index === at);
    const there = ordinal < 0 ? undefined : runs(raw)[ordinal];
    return there && there[0] === /^\d+/.exec(path.slice(at))?.[0] ? /** @type {number} */ (there.index) : -1;
  }

  /**
   * The addresses one episode on (or back), surest first. Only the number changes; padding stays.
   * @param {string} href - This page.
   * @param {boolean} isNext
   * @return {Array<string>} Absolute, without the #.
   */
  function neighbourEpisodeUrls(href, isNext) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return [];
    }
    url.hash = '';
    const step = isNext ? 1 : -1;
    /**
     * @param {string} digits
     * @return {string[]} The number one on, padded as it was; one back from 10 also as 09.
     */
    const bump = (digits) => {
      const n = parseInt(digits, 10) + step;
      if (!Number.isFinite(n) || n < 0) return [];
      const plain = String(n).padStart(digits.startsWith('0') ? digits.length : 0, '0');
      const padded = String(n).padStart(digits.length, '0');
      return padded === plain ? [plain] : [plain, padded];
    };
    /** @type {string[]} */
    const out = [];
    /** @param {string} candidate */
    const add = (candidate) => {
      if (candidate && candidate !== url.href && !out.includes(candidate)) out.push(candidate);
    };
    const raw = url.pathname;
    const path = readablePath(url);
    /**
     * @param {number} at - In the readable path.
     * @param {string} digits
     */
    const bumpAt = (at, digits) => {
      const rawAt = rawIndex(raw, path, at);
      if (rawAt < 0) return;
      for (const number of bump(digits)) {
        const copy = new URL(url.href);
        copy.pathname = raw.slice(0, rawAt) + number + raw.slice(rawAt + digits.length);
        add(copy.href);
      }
    };
    /** @param {RegExp} regex */
    const inPath = (regex) => {
      for (const match of path.matchAll(regex)) bumpAt(/** @type {number} */ (match.index) + match[1].length, match[2]);
    };
    inPath(/((?:^|[^\p{L}])(?:episodes?|episodio|episódio|épisode|folge|odcinek|bölüm|bolum|seriya|ep|e)[-_.]?)(\d+)/giu);
    inPath(/(s\d{1,3}[-_.]?e)(\d+)/gi);
    inPath(/((?:^|[^\d])\d{1,3}x)(\d{1,4})(?!\d)/gi);
    for (const [key, value] of url.searchParams) {
      if (/^(ep|eps|episode|episodio|e|folge|epi)$/i.test(key) && /^\d+$/.test(value)) {
        for (const number of bump(value)) {
          const copy = new URL(url.href);
          copy.searchParams.set(key, number);
          add(copy.href);
        }
      }
    }
    const last = /(\d+)(\D*)$/.exec(path);
    if (last) bumpAt(last.index, last[1]);
    return out;
  }

  const SEASON = '(?:staffel|season|saison|temporada|stagione|seizoen|sezon|sezona)';
  const EPISODE_WORD = '(?:episodes?|episodio|episódio|épisode|folge|odcinek|bölüm|bolum|seriya|ep|e)';
  // staffel-3, staffel-3-episode-12, episode-12, s03, S03E12, 3x12.
  const SEASON_EPISODE = `(?:${SEASON}[-_.]?\\d+(?:[-_.]?${EPISODE_WORD}[-_.]?\\d+)?|s\\d{1,3}(?:[-_.]?e\\d+)?|` +
    `${EPISODE_WORD}[-_.]?\\d+|\\d{1,3}x\\d{1,4})`;
  // A segment that is only a season or episode: what comes before the first one is the series.
  const PART = new RegExp(`^${SEASON_EPISODE}(?:\\.[a-z0-9]+)?$`, 'iu');
  // A segment naming the show, then its season or episode: one-piece-episode-1000.
  const NAMED_PART = new RegExp(`^(.+?[-_])${SEASON_EPISODE}(?:\\.[a-z0-9]+)?$`, 'iu');

  /**
   * The origin and the path up to the first season or episode: the series.
   * @param {string} href - The page.
   * @return {?string} Null where the address names no season or episode (/watch/12345).
   */
  function seriesOf(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    const segments = readablePath(url).split('/');
    for (let i = 1; i < segments.length; i++) {
      const before = url.origin + segments.slice(0, i).join('/') + '/';
      if (PART.test(segments[i])) return before;
      const named = NAMED_PART.exec(segments[i]);
      if (named) return before + named[1];
    }
    return null;
  }

  /**
   * Whether an address is in the series (seriesOf); any address is where none was told.
   * @param {?string} series
   * @param {string} href
   * @return {boolean}
   */
  function inSeries(series, href) {
    if (!series) return true;
    if (seriesOf(href) === series) return true;
    // .../girls/ holds its other parts (.../girls/ova/); .../girls-2/ is a sequel.
    if (!series.endsWith('/')) return false;
    try {
      const url = new URL(href);
      return (url.origin + readablePath(url)).startsWith(series);
    } catch (e) {
      return false;
    }
  }

  // Groups: before the season's number, the season, between, the episode, after.
  const SEASON_EPISODE_ENDS = [
    new RegExp(`^(.*[/_-]${SEASON}[-_.]?)(\\d+)([/_.-]?${EPISODE_WORD}[-_.]?)(\\d+)((?:\\.[a-z0-9]+)?/?)$`, 'iu'),
    /^(.*[/_.-]s)(\d{1,3})([-_.]?e)(\d{1,4})((?:\.[a-z0-9]+)?\/?)$/i,
    /^(.*[/_.-])(\d{1,3})(x)(\d{1,4})((?:\.[a-z0-9]+)?\/?)$/i,
  ];

  /**
   * The season and the episode an address names at its end.
   * @param {string} href
   * @return {?{show: string, season: number, episode: number, match: Array<string>, origin: string,
   *   raw: string, short: boolean}} show: lower case, the same in each season; short: S03E12, 3x12.
   */
  function seasonEpisode(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    const path = readablePath(url);
    for (const [i, form] of SEASON_EPISODE_ENDS.entries()) {
      const match = form.exec(path);
      if (match) {
        return {show: (url.origin + match[1]).toLowerCase(), season: parseInt(match[2], 10), episode: parseInt(match[4], 10),
          match, origin: url.origin, raw: url.pathname, short: i > 0};
      }
    }
    return null;
  }

  /**
   * After a season's last episode: .../staffel-3/episode-12 -> .../staffel-4, .../staffel-4/episode-1.
   * @param {string} href - This page.
   * @return {?{season: string, first: string}} Absolute, without the query or the #.
   */
  function nextSeason(href) {
    const here = seasonEpisode(href);
    if (!here) return null;
    const match = here.match;
    const season = String(here.season + 1).padStart(match[2].startsWith('0') ? match[2].length : 0, '0');
    // S04E01, 4x01: those write the episode with two digits.
    const padded = match[4].startsWith('0') || (here.short && match[4].length >= 2);
    const first = padded ? '1'.padStart(match[4].length, '0') : '1';
    const path = match[0];
    const seasonAt = rawIndex(here.raw, path, match[1].length);
    const episodeAt = rawIndex(here.raw, path, match[1].length + match[2].length + match[3].length);
    if (seasonAt < 0 || episodeAt < 0) return null;
    const before = here.origin + here.raw.slice(0, seasonAt) + season;
    return {
      season: before,
      first: before + here.raw.slice(seasonAt + match[2].length, episodeAt) + first + here.raw.slice(episodeAt + match[4].length),
    };
  }

  return {normalize, phraseScore, neighbourEpisodeUrls, seriesOf, inSeries, seasonEpisode, nextSeason};
})();
