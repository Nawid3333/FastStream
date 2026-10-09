// @ts-check

// Which title a subtitle search means, and how to ask for that title's subtitles
// (OpenSubtitlesSearch). Measured against the OpenSubtitles REST API (2026-10-09, the answers
// are in tests/unit/fixtures/opensubtitles):
// - A text search for subtitles mixes titles: for "oppenheimer" in German a 2025 documentary came
//   first and the film's most downloaded subtitle was not in the first 8; for "titanic" the 1997
//   film was not in the first 50 (Titane, The Titan, Titanic 1953 were). For "the bear" S02E03
//   it found the show, and also Masha and the Bear.
// - A title search (features) finds what the text search misses (Titanic 1997 first, The Bear
//   2022 with type=tvshow, 1917 among 39), and misses what it finds (Dune: Part Two).
// - The subtitles of one title, asked for by its IMDb id (a movie) or its show's feature id (an
//   episode) and sorted by downloads, are exactly that title's, the most used first.
// So both searches run, their titles are pooled and scored here, and the best one's subtitles
// are asked for by id.

/**
 * @typedef {Object} TitleCandidate
 * @property {string} key - 'movie:<imdb id>' or 'show:<feature id>'.
 * @property {'movie'|'show'} kind
 * @property {string} title
 * @property {?number} year
 * @property {?number} imdbId - A movie's.
 * @property {?number} showId - A show's feature id: the parent_feature_id of its episodes.
 * @property {number} subtitles - How many subtitles it has, in the language when known.
 * @property {number} order - Where the searches first listed it.
 */

/**
 * A title as compared: accents, case and punctuation left out.
 * @param {*} text
 * @return {string}
 */
export function normalizeTitle(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * @param {string} title - Normalized.
 * @return {string}
 */
function withoutArticle(title) {
  return title.replace(/^(?:the|a|an|der|die|das|le|la|les|el|los|il)\s+/, '');
}

/**
 * The titles a title search (GET /features) found.
 * @param {Array<Object>} features - Its data.
 * @param {string} [language] - The language asked for: its subtitles are counted.
 * @return {TitleCandidate[]}
 */
export function titlesFromFeatures(features, language = '') {
  /** @type {TitleCandidate[]} */
  const out = [];
  (features || []).forEach((item, index) => {
    const a = item?.attributes;
    if (!a) return;
    const counts = a.subtitles_counts || {};
    const subtitles = language ? (counts[language] || 0) :
      Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
    const year = Number(a.year) || null;
    // The title search writes titles in lower case ("the bear"); its original title is the same
    // one in its own spelling, when it is the same.
    const name = a.original_title && normalizeTitle(a.original_title) === normalizeTitle(a.title) ? a.original_title : (a.title || '');
    // Searched with a type, an entry has none of its own: the item's type says it.
    const type = a.feature_type || {tvshow: 'Tvshow', movie: 'Movie', episode: 'Episode'}[item.type];
    if (type === 'Tvshow' && a.feature_id) {
      out.push({key: `show:${a.feature_id}`, kind: 'show', title: name, year, imdbId: null,
        showId: Number(a.feature_id), subtitles, order: index});
    } else if (type === 'Movie' && a.imdb_id) {
      out.push({key: `movie:${a.imdb_id}`, kind: 'movie', title: name, year, imdbId: Number(a.imdb_id),
        showId: null, subtitles, order: index});
    }
  });
  return out;
}

/**
 * The titles a text search for subtitles (GET /subtitles?query=) found, one per movie or show.
 * @param {Array<Object>} subtitles - Its data.
 * @return {TitleCandidate[]}
 */
export function titlesFromSubtitles(subtitles) {
  /** @type {Map<string, TitleCandidate>} */
  const titles = new Map();
  (subtitles || []).forEach((item, index) => {
    const f = item?.attributes?.feature_details;
    if (!f) return;
    /** @type {TitleCandidate} */
    let candidate;
    if (f.feature_type === 'Episode' && f.parent_feature_id) {
      candidate = {key: `show:${f.parent_feature_id}`, kind: 'show', title: f.parent_title || '', year: null,
        imdbId: null, showId: Number(f.parent_feature_id), subtitles: 0, order: index};
    } else if (f.feature_type !== 'Episode' && f.imdb_id) {
      candidate = {key: `movie:${f.imdb_id}`, kind: 'movie', title: f.title || f.movie_name || '',
        year: Number(f.year) || null, imdbId: Number(f.imdb_id), showId: null, subtitles: 0, order: index};
    } else {
      return;
    }
    const known = titles.get(candidate.key);
    if (known) {
      known.subtitles++;
    } else {
      candidate.subtitles = 1;
      titles.set(candidate.key, candidate);
    }
  });
  return [...titles.values()];
}

/**
 * Both searches' titles in one list, a title both found once, with the larger count.
 * @param {TitleCandidate[]} first
 * @param {TitleCandidate[]} second
 * @return {TitleCandidate[]}
 */
export function poolTitles(first, second) {
  /** @type {Map<string, TitleCandidate>} */
  const pooled = new Map();
  [...first, ...second].forEach((candidate) => {
    const known = pooled.get(candidate.key);
    if (!known) {
      pooled.set(candidate.key, {...candidate});
      return;
    }
    known.subtitles = Math.max(known.subtitles, candidate.subtitles);
    known.order = Math.min(known.order, candidate.order);
    known.year = known.year ?? candidate.year;
    if (!known.title) known.title = candidate.title;
  });
  return [...pooled.values()];
}

/**
 * How well a title's name matches the one searched for, 0 to 100.
 * @param {string} title
 * @param {string} wanted
 * @return {number}
 */
export function nameMatch(title, wanted) {
  const a = normalizeTitle(title);
  const b = normalizeTitle(wanted);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (withoutArticle(a) === withoutArticle(b)) return 95;
  // One is the other with more words after it: "Dune" for "Dune Part Two", "The Office" for
  // "The Office US".
  if (a.startsWith(b + ' ') || b.startsWith(a + ' ')) return 60;
  const wordsA = new Set(a.split(' '));
  const wordsB = new Set(b.split(' '));
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  const share = shared / new Set([...wordsA, ...wordsB]).size;
  return share >= 0.5 ? Math.round(50 * share) : 0;
}

/**
 * The titles, the most likely first.
 * @param {TitleCandidate[]} candidates
 * @param {{name: string, year?: ?number, season?: ?number, episode?: ?number}} wanted
 * @return {Array<TitleCandidate & {score: number, name: number}>} name: the name's match alone.
 */
export function rankTitles(candidates, wanted) {
  const episode = wanted.season != null || wanted.episode != null;
  return candidates.map((candidate) => {
    const name = nameMatch(candidate.title, wanted.name);
    let score = name;
    if (wanted.year && candidate.year) {
      const off = Math.abs(candidate.year - wanted.year);
      score += off === 0 ? 30 : off === 1 ? 10 : -40;
    }
    if (episode) {
      score += candidate.kind === 'show' ? 30 : -50;
    } else {
      score += candidate.kind === 'movie' ? 10 : -10;
    }
    // The popular one of two of the same name ("The Office" 2005 and 2001, "1917" 2019 and 1970).
    score += Math.min(20, 5 * Math.log10(1 + candidate.subtitles));
    score -= candidate.order * 0.01;
    return {...candidate, score, name};
  }).sort((x, y) => y.score - x.score);
}

/**
 * The title a search takes, and the others it offers: those whose name matches at least
 * minMatch (out of 100), each once (the API keeps some titles twice, and either search may name
 * one). When no name matches, the text search's own match counts: it knows a film's other
 * titles ("Amélie" for "Die fabelhafte Welt der Amélie"), where the titles here are the English
 * or original ones.
 * @param {TitleCandidate[]} fromText - titlesFromSubtitles.
 * @param {TitleCandidate[]} fromTitles - titlesFromFeatures.
 * @param {{name: string, year?: ?number, season?: ?number, episode?: ?number}} wanted
 * @param {{most?: number, minMatch?: number}} [options]
 * @return {?{best: TitleCandidate, others: TitleCandidate[]}}
 */
export function chooseTitles(fromText, fromTitles, wanted, {most = 6, minMatch = 40} = {}) {
  let ranked = rankTitles(poolTitles(fromText, fromTitles), wanted).filter((title) => title.name > 0);
  if (!ranked.length) {
    ranked = rankTitles(fromText, wanted);
  }
  if (!ranked.length) {
    return null;
  }
  const label = (title) => `${normalizeTitle(title.title)}|${title.year ?? ''}`;
  const seen = new Set([label(ranked[0])]);
  const others = [];
  for (const title of ranked.slice(1)) {
    if (others.length >= most) break;
    if (title.name < minMatch || seen.has(label(title))) continue;
    seen.add(label(title));
    others.push(title);
  }
  return {best: ranked[0], others};
}

/**
 * The query for one title's subtitles (GET /subtitles), the most downloaded first.
 * @param {TitleCandidate} title
 * @param {{language?: string, season?: ?number, episode?: ?number, page?: number}} options
 * @return {Object<string, string>}
 */
export function titleQuery(title, {language = '', season = null, episode = null, page = 1}) {
  /** @type {Object<string, string>} */
  const query = {order_by: 'download_count'};
  if (title.kind === 'show') {
    query.parent_feature_id = String(title.showId);
    if (season != null) query.season_number = String(season);
    if (episode != null) query.episode_number = String(episode);
  } else {
    query.imdb_id = String(title.imdbId);
  }
  if (language) query.languages = language;
  if (page > 1) query.page = String(page);
  return query;
}

/**
 * What a subtitle's row shows: its release name (which version of the video it was made for),
 * how often it was downloaded, and what kind it is.
 * @param {Object} attributes - A subtitle's, from the API.
 * @return {{release: string, downloads: number, language: string, uploader: string,
 *   fps: ?number, hearingImpaired: boolean, machine: boolean, trusted: boolean}}
 */
export function describeSubtitle(attributes) {
  const a = attributes || {};
  const details = a.feature_details || {};
  return {
    release: String(a.release || details.movie_name || details.title || '').trim(),
    downloads: Number(a.download_count) || 0,
    language: String(a.language || ''),
    uploader: String(a.uploader?.name || ''),
    fps: Number(a.fps) > 0 ? Number(a.fps) : null,
    hearingImpaired: !!a.hearing_impaired,
    machine: !!(a.ai_translated || a.machine_translated),
    trusted: !!a.from_trusted,
  };
}
