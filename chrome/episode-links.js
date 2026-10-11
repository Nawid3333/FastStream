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
   * Lower case, single spaces, no arrows at either end.
   * @param {*} text
   * @return {string}
   */
  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(MARKS, '').trim().toLocaleLowerCase();
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

  return {normalize, phraseScore, neighbourEpisodeUrls};
})();
