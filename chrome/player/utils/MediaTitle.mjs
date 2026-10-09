// @ts-check

// What a video is, guessed from the title of the tab that plays it: on a streaming site that is
// the only clue (an HLS stream has no file name). The subtitle search starts from it
// (OpenSubtitlesSearch). The guess before this one (2026-10-09) kept only the letters a-z, so
// "Amélie" lost a letter and "Spider-Man" its dash; dropped the year it found; kept "1080p"; and
// dropped words such as "part" or "show" wherever they were ("Dune Part Two" became "Dune Two",
// "The Truman Show" "The Truman"). tests/unit/MediaTitle.test.mjs has the titles it is made for.

import {StringUtils} from './StringUtils.mjs';

// Between a title and what a site adds to it: spaced dashes, bars, double colons, bullets.
const SEPARATORS = /\s+(?:[|–—•·]|-{1,2}|::|>>?)\s+/;

// Words a site puts before or after a title, never inside one: taken off at either end only.
// English and German, as the sites the player is used on.
const EDGE_WORDS = new Set([
  'watch', 'watching', 'stream', 'streaming', 'streams', 'online', 'free', 'for', 'full', 'movie',
  'movies', 'film', 'films', 'hd', 'fullhd', 'uhd', 'sd', 'in', 'now', 'here', 'sub', 'subbed', 'dub',
  'dubbed', 'english', 'englisch', 'eng', 'german', 'ger', 'deutsch', 'dt', 'kostenlos', 'gratis',
  'ganzer', 'ganze', 'anschauen', 'ansehen', 'gucken', 'schauen', 'auf', 'und', 'mit', 'untertitel',
  'subtitles', 'subtitle', 'episodes', 'folgen', 'seasons', 'staffeln',
  'tv', 'anime', 'kinofilm', 'trailer', 'official', 'video', 'videos', 'the', 'a', 'an', 'of',
  'and', 'or', 'on', 'at', 'to', 'with', 'by', 'from', 'der', 'die', 'das', 'doku', 'documentary',
]);
// Edge words that can begin a real title ("The Bear", "Die Hard", "Free Guy", "In the Heat of
// the Night"), and ones that can end one ("Apocalypse Now", "Scary Movie"): kept there when only
// such words stand between them and a word of the title ("Watch the free movie Oppenheimer"
// loses "the free movie", "... Full Movie" its "Movie").
const MAY_START = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'on', 'at', 'to', 'with', 'by', 'from',
  'der', 'die', 'das', 'in', 'for', 'und', 'mit', 'auf', 'now', 'here', 'full', 'free', 'tv']);
const MAY_END = new Set(['now', 'here', 'in', 'on', 'movie', 'movies', 'film', 'films', 'tv', 'anime', 'video']);

// Streaming services, named in a title part of their own ("| Netflix", "- Disney+").
const SERVICES = new Set(['netflix', 'disney', 'disneyplus', 'prime', 'primevideo', 'amazon', 'hulu',
  'hbo', 'hbomax', 'max', 'paramount', 'paramountplus', 'peacock', 'crunchyroll', 'sky', 'wow', 'joyn',
  'appletv', 'apple', 'youtube', 'mubi', 'plex', 'tubi', 'pluto', 'plutotv', 'rtl', 'rtlplus', 'ard',
  'zdf', 'arte', 'mediathek', 'iplayer', 'video', 'tv', 'plus']);

// Picture and encoding words: never part of a title, wherever they are.
const QUALITY = /^(?:\d{3,4}p|[48]k|uhd|hdr\d*|sdr|x26[45]|h26[45]|hevc|avc|av1|aac\d*|ac3|eac3|dts|webdl|webrip|bluray|brrip|bdrip|dvdrip|hdrip|hdtv|cam|hdcam|hdts|telesync|remux|mp4|mkv)$/;

// A season and an episode, each pattern with its season and its episode group.
const EPISODE_PATTERNS = [
  /\bs(\d{1,2})[ .]?e[p]?(\d{1,4})\b/i,
  /\b(\d{1,2})[x×](\d{1,4})\b/i,
  /\b(?:season|staffel)\s*(\d{1,2})\s*[,.-]?\s*(?:episode|folge|ep\.?)\s*(\d{1,4})\b/i,
];
// One of them alone. The short forms touch their number ("S2", "E12"): "Ocean's 11" has no
// season 11.
const SEASON_ONLY = /\b(?:(?:season|staffel)\s*(\d{1,2})|s(\d{1,2}))\b/i;
const EPISODE_ONLY = /\b(?:(?:episode|folge|ep\.?)\s*(\d{1,4})|e(\d{1,4}))\b/i;

// Second-level labels that are no site's name ("bbc.co.uk").
const GENERIC_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/**
 * A word as compared: lower case, letters and digits only.
 * @param {string} word
 * @return {string}
 */
function bare(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether a word is the site's name, or close to it ("FMovies" on fmovies.to, "kino.to").
 * @param {string} word
 * @param {string} site - The site's name, lower case.
 * @return {boolean}
 */
function isSiteName(word, site) {
  const lower = bare(word);
  if (site.length < 3 || !lower) return false;
  return lower === site || (lower.length >= 4 && (site.startsWith(lower) || lower.startsWith(site))) ||
    (lower.length > 3 && StringUtils.levenshteinDistance(lower, site) < Math.ceil(site.length * 0.4));
}

/**
 * The words of a part of the title: letters of every language, digits, and the punctuation of
 * titles ("Mission:", "Ocean's", "Spider-Man", "Mr.", "Disney+"); nothing else.
 * @param {string} text
 * @return {string[]}
 */
function words(text) {
  return text.split(/\s+/)
      .map((word) => word.replace(/[^\p{L}\p{N}:'’&.!?,+/-]+/gu, '').replace(/^[:'’&.!?,+/-]+|[,/]+$/g, ''))
      .filter((word) => bare(word));
}

/**
 * Takes the words a site puts around a title off either end.
 * @param {string[]} list
 * @return {string[]}
 */
function trimEdges(list) {
  const out = list.slice();
  const strip = (atStart) => {
    const keep = atStart ? MAY_START : MAY_END;
    // Whether, from the word at index inwards, only words that may stand there come before a
    // word of the title.
    const leadsToTitle = (index) => {
      for (let i = index; atStart ? i < out.length : i >= 0; i += atStart ? 1 : -1) {
        const word = bare(out[i]);
        if (!EDGE_WORDS.has(word)) return i !== index;
        if (!keep.has(word)) return false;
      }
      return false;
    };
    while (out.length) {
      const index = atStart ? 0 : out.length - 1;
      if (!EDGE_WORDS.has(bare(out[index])) || leadsToTitle(index)) break;
      out.splice(index, 1);
    }
  };
  strip(true);
  strip(false);
  strip(true);
  return out;
}

/**
 * What the video is, as far as the tab's title tells.
 * @param {string} title - The tab's title.
 * @param {string} [hostname] - The site's host name, to take its name out.
 * @param {number} [now] - The current year: a 4-digit number later than next year is no year.
 * @return {{name: string, year: ?number, season: ?number, episode: ?number}}
 */
export function guessMediaInfo(title, hostname = '', now = new Date().getFullYear()) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  let site = labels.length >= 2 ? labels[labels.length - 2] : (labels[0] || '');
  if (GENERIC_LABELS.has(site) && labels.length >= 3) site = labels[labels.length - 3];
  site = bare(site);
  let text = String(title || '').replace(/\s+/g, ' ').trim();

  /** @type {?number} */
  let season = null;
  /** @type {?number} */
  let episode = null;
  /** @type {?number} */
  let year = null;

  // A season and episode marker ends the title: what follows is the episode's own title or the
  // site's ("The Bear S02E03 Sundae"). One at the very start is cut off instead ("S02E03 - The
  // Bear").
  const cutAt = (start, end) => {
    text = text.slice(0, start).trim() ? text.slice(0, start) : text.slice(end);
  };
  for (const pattern of EPISODE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      season = parseInt(match[1], 10);
      episode = parseInt(match[2], 10);
      cutAt(match.index, match.index + match[0].length);
      break;
    }
  }
  if (season === null) {
    const seasonMatch = SEASON_ONLY.exec(text);
    const episodeMatch = EPISODE_ONLY.exec(text);
    if (seasonMatch) season = parseInt(seasonMatch[1] ?? seasonMatch[2], 10);
    if (episodeMatch) episode = parseInt(episodeMatch[1] ?? episodeMatch[2], 10);
    const found = [seasonMatch, episodeMatch].filter((match) => match !== null)
        .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    if (found.length) {
      const last = found[found.length - 1];
      cutAt(found[0]?.index ?? 0, (last?.index ?? 0) + (last?.[0].length ?? 0));
    }
  }

  // A year in brackets is the year ("1917 (2019)").
  const bracketed = /[([]\s*((?:19|20)\d{2})\s*[)\]]/.exec(text);
  if (bracketed && Number(bracketed[1]) <= now + 1) {
    year = Number(bracketed[1]);
    text = text.slice(0, bracketed.index) + ' ' + text.slice(bracketed.index + bracketed[0].length);
  }

  // The parts between separators. A part that is only the site's or a service's name, or only
  // words a site adds, goes.
  const parts = text.split(SEPARATORS)
      .map((part) => words(part).filter((word) => !QUALITY.test(bare(word))))
      .map((part) => part.filter((word, index) => !((index === 0 || index === part.length - 1) && isSiteName(word, site))))
      .map(trimEdges)
      .filter((part) => part.length && !part.every((word) => SERVICES.has(bare(word)) || isSiteName(word, site)));

  // A bare year after the title ("Oppenheimer 2023"), not the title itself ("1917", "2012")
  // nor a number in it ("Blade Runner 2049": later than next year).
  // The year can also stand before a word kept at the end ("Oppenheimer 2023 Movie"), also
  // in a part of its own after the title ("Oppenheimer | 2023 Movie"), but not as the title
  // ("2012 Movie").
  const last = parts[parts.length - 1];
  if (year === null && last && (last.length > 1 || parts.length > 1)) {
    const isYear = (word) => /^(?:19|20)\d{2}$/.test(word ?? '') && Number(word) <= now + 1;
    const at = isYear(last[last.length - 1]) ? last.length - 1 :
      ((last.length > 2 || (last.length === 2 && parts.length > 1)) && isYear(last[last.length - 2]) && EDGE_WORDS.has(bare(last[last.length - 1])) ? last.length - 2 : -1);
    if (at >= 0) {
      year = Number(last[at]);
      last.splice(at);
      const trimmed = trimEdges(last);
      last.splice(0, last.length, ...trimmed);
      if (!last.length) parts.pop();
    }
  }

  return {name: parts.map((part) => part.join(' ')).join(' - '), year, season, episode};
}
