// @ts-check
// The next (or the previous) episode of a series page, for content.js: the autoplay and the
// player's next and previous buttons (his wish, 2026-10-11: on as many sites as possible).
// Pure - what a link says, and which addresses this page's episode number +1 (or -1) would
// have; content.js looks for them among the page's links.
//
// Measured first (2026-10-11): content.js knew an English "next" or "next episode" link, the
// neighbour of this page's link in a list, and "Episode N" lists. A German "Nächste Folge",
// an icon link with only an aria-label, and the plain .../episode-12 -> .../episode-13 of
// most hosters went unseen.
// eslint-disable-next-line no-unused-vars
const EpisodeLinks = (() => {
  // An episode phrase: "next episode" in the languages FastStream speaks and the ones its
  // sites are in. Lower case, single spaces.
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
  // Arrows and marks around a link's words ("Next episode »", "‹ Zurück").
  const MARKS = /^[\s«»‹›<>←→⟨⟩❮❯|·•…:\-–—]+|[\s«»‹›<>←→⟨⟩❮❯|·•…:\-–—]+$/g;

  /**
   * Lower case, single spaces, no arrows at either end. The same in every locale, with the
   * Turkish i's as a plain i: in a Turkish Firefox "NEXT EPISODE" became "next epısode", and
   * in any, "SONRAKİ BÖLÜM" became "sonraki̇ bölüm", with a dot added (glm's review,
   * 2026-10-13). No phrase above has a dotless ı of its own.
   * @param {*} text
   * @return {string}
   */
  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(MARKS, '').trim().toLowerCase()
        .replace(/i̇/g, 'i').replace(/ı/g, 'i');
  }

  /**
   * How surely a link's words mean the next (or the previous) episode: 2 an episode phrase
   * ("Nächste Folge", also with a number or a title after it), 1 a bare word ("weiter"), 0
   * neither, or a page of a list.
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
   * The addresses this page's episode would have one episode on (or back), surest first: the
   * number after an episode word (episode-12, folge12, ep_12), S01E12, 1x12, an ep= in the
   * query, then the path's last number (/watch/12). Only the number changes, so the series
   * stays the same; zero padding is kept (ep-09 -> ep-10, 007 -> 008).
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
    const bump = (digits) => {
      const n = parseInt(digits, 10) + step;
      if (!Number.isFinite(n) || n < 0) return null;
      return String(n).padStart(digits.startsWith('0') ? digits.length : 0, '0');
    };
    const out = [];
    const add = (candidate) => {
      if (candidate && candidate !== url.href && !out.includes(candidate)) out.push(candidate);
    };
    const inPath = (regex) => {
      for (const match of url.pathname.matchAll(regex)) {
        const number = bump(match[2]);
        if (number === null) continue;
        const at = match.index + match[1].length;
        const copy = new URL(url.href);
        copy.pathname = url.pathname.slice(0, at) + number + url.pathname.slice(at + match[2].length);
        add(copy.href);
      }
    };
    inPath(/((?:^|[^\p{L}])(?:episodes?|episodio|episódio|épisode|folge|odcinek|bölüm|bolum|seriya|ep|e)[-_.]?)(\d+)/giu);
    inPath(/(s\d{1,3}[-_.]?e)(\d+)/gi);
    inPath(/((?:^|[^\d])\d{1,3}x)(\d{1,4})(?!\d)/gi);
    for (const [key, value] of url.searchParams) {
      if (/^(ep|eps|episode|episodio|e|folge|epi)$/i.test(key) && /^\d+$/.test(value)) {
        const number = bump(value);
        if (number === null) continue;
        const copy = new URL(url.href);
        copy.searchParams.set(key, number);
        add(copy.href);
      }
    }
    const last = /(\d+)(\D*)$/.exec(url.pathname);
    if (last) {
      const number = bump(last[1]);
      if (number !== null) {
        const copy = new URL(url.href);
        copy.pathname = url.pathname.slice(0, last.index) + number + last[2];
        add(copy.href);
      }
    }
    return out;
  }

  // A season in an address ("staffel-3", "season_2").
  const SEASON = '(?:staffel|season|saison|temporada|stagione|seizoen|sezon|sezona)';
  // An episode in an address.
  const EPISODE_WORD = '(?:episodes?|episodio|episódio|épisode|folge|odcinek|bölüm|bolum|seriya|ep|e)';
  // A season, an episode, or both, as a path segment names them (staffel-3, staffel-3-episode-12,
  // episode-12, s03, S03E12, 3x12).
  const SEASON_EPISODE = `(?:${SEASON}[-_.]?\\d+(?:[-_.]?${EPISODE_WORD}[-_.]?\\d+)?|s\\d{1,3}(?:[-_.]?e\\d+)?|` +
    `${EPISODE_WORD}[-_.]?\\d+|\\d{1,3}x\\d{1,4})`;
  // A path segment that is one: what comes before the first one is the series
  // (/anime/stream/<series>/staffel-3/episode-12).
  const PART = new RegExp(`^${SEASON_EPISODE}(?:\\.[a-z0-9]+)?$`, 'iu');
  // A segment that names the show and then its season or episode: one-piece-episode-1000,
  // my-show-season-2-episode-5.
  const NAMED_PART = new RegExp(`^(.+?[-_])${SEASON_EPISODE}(?:\\.[a-z0-9]+)?$`, 'iu');

  /**
   * The part of a page's address that names its series (2026-10-11, an anime site: after a
   * season's last episode, autoplay went to another series): the path up to its first season
   * or episode segment, or up to the episode in a segment that names the show too.
   * @param {string} href - The page.
   * @return {?string} The origin and that path, or null for an address with no season or
   *   episode in it (/watch/12345), where the series cannot be told.
   */
  function seriesOf(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    const segments = url.pathname.split('/');
    for (let i = 1; i < segments.length; i++) {
      const before = url.origin + segments.slice(0, i).join('/') + '/';
      if (PART.test(segments[i])) return before;
      const named = NAMED_PART.exec(segments[i]);
      if (named) return before + named[1];
    }
    return null;
  }

  /**
   * Whether an address is an episode or a season of a series (seriesOf): its own series is
   * that one, so a sequel that only starts the same (one-piece-2/... beside
   * one-piece-episode-1000) is not. Any address is where no series was told.
   * @param {?string} series
   * @param {string} href
   * @return {boolean}
   */
  function inSeries(series, href) {
    if (!series) return true;
    if (seriesOf(href) === series) return true;
    // A series that is a folder (.../girls/) has its other parts in it too (.../girls/ova/...);
    // a sequel's folder (.../girls-2/) is not in it (kimi's review, 2026-10-11).
    if (!series.endsWith('/')) return false;
    try {
      const url = new URL(href);
      return (url.origin + url.pathname).startsWith(series);
    } catch (e) {
      return false;
    }
  }

  // An address that ends in a season's episode, each the same groups (before the season's
  // number, the season, between, the episode, after): .../staffel-3/episode-12,
  // .../staffel-3-episode-12, .../S03E12, .../3x12.
  const SEASON_EPISODE_ENDS = [
    new RegExp(`^(.*[/_-]${SEASON}[-_.]?)(\\d+)([/_.-]?${EPISODE_WORD}[-_.]?)(\\d+)((?:\\.[a-z0-9]+)?/?)$`, 'iu'),
    /^(.*[/_.-]s)(\d{1,3})([-_.]?e)(\d{1,4})((?:\.[a-z0-9]+)?\/?)$/i,
    /^(.*[/_.-])(\d{1,3})(x)(\d{1,4})((?:\.[a-z0-9]+)?\/?)$/i,
  ];

  /**
   * The season and the episode an address names at its end.
   * @param {string} href
   * @return {?{show: string, season: number, episode: number, match: Array<string>, origin: string,
   *   short: boolean}} show: the address before the season's number, in lower case (the same for
   *   each season of a series); short: an S03E12 or a 3x12, whose episodes have two digits.
   */
  function seasonEpisode(href) {
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }
    for (const [i, form] of SEASON_EPISODE_ENDS.entries()) {
      const match = form.exec(url.pathname);
      if (match) {
        return {show: (url.origin + match[1]).toLowerCase(), season: parseInt(match[2], 10), episode: parseInt(match[4], 10),
          match, origin: url.origin, short: i > 0};
      }
    }
    return null;
  }

  /**
   * After the last episode of a season, the next season's first: .../staffel-3/episode-12 ->
   * the season .../staffel-4 (which the page must link, or one of its episodes) and its first
   * episode .../staffel-4/episode-1, padded as this one is; also .../staffel-3-episode-12.
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
    return {
      season: here.origin + match[1] + season,
      first: here.origin + match[1] + season + match[3] + first + match[5],
    };
  }

  return {normalize, phraseScore, neighbourEpisodeUrls, seriesOf, inSeries, seasonEpisode, nextSeason};
})();
