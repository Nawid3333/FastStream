import {SubtitleTrack} from '../../SubtitleTrack.mjs';
import {Localize} from '../../modules/Localize.mjs';
import {EventEmitter} from '../../modules/eventemitter.mjs';
import {AlertPolyfill} from '../../utils/AlertPolyfill.mjs';
import {EnvUtils} from '../../utils/EnvUtils.mjs';
import {InterfaceUtils} from '../../utils/InterfaceUtils.mjs';
import {RequestUtils} from '../../utils/RequestUtils.mjs';
import {SubtitleUtils} from '../../utils/SubtitleUtils.mjs';
import {WebUtils} from '../../utils/WebUtils.mjs';
import {DOMElements} from '../DOMElements.mjs';
import {createPagesBar} from '../components/PagesBar.mjs';
import {chooseTitles, describeSubtitle, titleQuery, titlesFromFeatures, titlesFromSubtitles} from './SubtitleSearchTitles.mjs';

const API_KEY = 'jolY3ZCVYguxFxl8CkIKl52zpHJT2eTw';
const API = 'https://api.opensubtitles.com/api/v1/';

export const OpenSubtitlesSearchEvents = {
  TRACK_DOWNLOADED: 'trackDownloaded',
};

/** What the API answered instead of results: its message, or none. */
class SearchError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.fromApi = true;
  }
}

/**
 * A title as shown: the API's title search writes them in lower case ("the bear").
 * @param {{title: string, year: ?number}} title
 * @return {string}
 */
function titleLabel(title) {
  const text = String(title.title ?? '');
  // Small words stay small, but at the start ("Masha and the Bear", "The Bear").
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'or',
    'der', 'die', 'das', 'und']);
  const name = text !== text.toLowerCase() ? text : text.replace(/(^|[\s:(-])(\p{L}+)/gu, (match, before, word, offset) =>
    before + (offset > 0 && before !== ':' && small.has(word) ? word : word[0].toUpperCase() + word.slice(1)));
  return title.year ? `${name} (${title.year})` : name;
}

/**
 * Searches OpenSubtitles for the video's subtitles and loads the one picked. A search finds the
 * title first, then lists that title's subtitles, the most downloaded first (SubtitleSearchTitles).
 */
export class OpenSubtitlesSearch extends EventEmitter {
  constructor(version) {
    super();
    this.subui = {};
    this.version = version;
    this.searchCount = 0;
    // Bumped when the player's subtitles are cleared (a new video): a download started
    // before that belongs to the video before.
    this.downloadGeneration = 0;
    this.setupUI();
  }

  /** Drops the downloads still running: their subtitles were for the video before. */
  dropPendingDownloads() {
    this.downloadGeneration++;
  }

  openUI() {
    InterfaceUtils.closeWindows();
    DOMElements.subuiContainer.style.display = '';
    this.subui.search.focus();
  }

  closeUI() {
    DOMElements.subuiContainer.style.display = 'none';
  }

  isOpen() {
    return DOMElements.subuiContainer.style.display !== 'none';
  }

  toggleUI() {
    if (!this.isOpen()) {
      this.openUI();
    } else {
      this.closeUI();
    }
  }

  /**
   * A text field of the search.
   * @param {string} className
   * @param {string} placeholderKey
   * @return {HTMLInputElement}
   */
  createInput(className, placeholderKey) {
    const input = WebUtils.create('input', null, 'text_input');
    input.placeholder = Localize.getMessage(placeholderKey);
    input.classList.add(className);
    input.ariaLabel = input.placeholder;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        this.subui.search.blur();
        this.startSearch();
      }
    });
    this.subui.searchContainer.appendChild(input);
    return input;
  }

  setupUI() {
    DOMElements.subuiContainer.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    DOMElements.subuiContainer.addEventListener('dblclick', (e) => {
      e.stopPropagation();
    });

    DOMElements.subuiContainer.addEventListener('keyup', (e) => {
      e.stopPropagation();
    });

    const closeBtn = DOMElements.subuiContainer.getElementsByClassName('close_button')[0];
    closeBtn.addEventListener('click', (e) => {
      this.closeUI();
    });

    WebUtils.setupTabIndex(closeBtn);
    const contentContainer = DOMElements.subuiContainer.getElementsByClassName('content_container')[0];

    this.subui.searchContainer = document.createElement('div');
    this.subui.searchContainer.classList.add('subtitle-search-container');
    contentContainer.appendChild(this.subui.searchContainer);

    this.subui.search = this.createInput('subtitle-search-input', 'player_opensubtitles_search_placeholder');

    const searchBtn = WebUtils.create('div', null, 'textbutton subtitle-search-btn');
    searchBtn.textContent = Localize.getMessage('player_opensubtitles_searchbtn');
    WebUtils.setupTabIndex(searchBtn);
    searchBtn.addEventListener('click', () => this.startSearch());
    this.subui.searchContainer.appendChild(searchBtn);

    // Filled in, a season or an episode makes it an episode's search.
    this.subui.seasonInput = this.createInput('subtitle-season-input', 'player_opensubtitles_seasonnum');
    this.subui.episodeInput = this.createInput('subtitle-episode-input', 'player_opensubtitles_episodenum');
    this.subui.languageInput = this.createInput('subtitle-language-input', 'player_opensubtitles_language');
    this.subui.yearInput = this.createInput('subtitle-year-input', 'player_opensubtitles_year');

    // The title the results are for, and the other titles found.
    this.subui.title = document.createElement('div');
    this.subui.title.classList.add('subtitle-search-title');
    contentContainer.appendChild(this.subui.title);

    this.subui.results = document.createElement('div');
    this.subui.results.classList.add('subtitle-results');
    contentContainer.appendChild(this.subui.results);

    this.subui.pages = document.createElement('div');
    this.subui.pages.classList.add('subtitle-pages');
    contentContainer.appendChild(this.subui.pages);

    this.loadFromSession();
  }

  /**
   * The search's fields.
   * @return {{query: string, language: string, year: ?number, season: ?number, episode: ?number}}
   */
  readInputs() {
    const number = (input) => {
      const value = parseInt(input.value, 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    return {
      query: this.subui.search.value.trim(),
      language: this.subui.languageInput.value.trim(),
      year: number(this.subui.yearInput),
      season: number(this.subui.seasonInput),
      episode: number(this.subui.episodeInput),
    };
  }

  /** Searches with what the fields hold, and keeps them for the tab's next player. */
  startSearch() {
    this.saveToSession();
    this.search(this.readInputs());
  }

  loadFromSession() {
    let inputData;
    try {
      inputData = JSON.parse(sessionStorage.getItem('subtitleSearch') || 'null');
    } catch (e) {
      return;
    }
    if (!inputData) {
      return;
    }

    this.subui.search.value = inputData.query || '';
    this.subui.languageInput.value = inputData.language || '';
    this.subui.yearInput.value = inputData.year || '';
    this.subui.seasonInput.value = inputData.season || '';
    this.subui.episodeInput.value = inputData.episode || '';
  }

  saveToSession() {
    const inputData = {
      query: this.subui.search.value,
      language: this.subui.languageInput.value,
      year: this.subui.yearInput.value,
      season: this.subui.seasonInput.value,
      episode: this.subui.episodeInput.value,
    };

    sessionStorage.setItem('subtitleSearch', JSON.stringify(inputData));
  }

  /**
   * Asks the OpenSubtitles API.
   * @param {string} path - 'subtitles' or 'features'.
   * @param {Object<string, string>} query
   * @return {Promise<Object>} Its answer, with results (data).
   */
  async request(path, query) {
    // In alphabetical order, as the API asks (it redirects other orders).
    const sorted = {};
    Object.keys(query).sort().forEach((key) => {
      if (query[key] !== '' && query[key] !== undefined && query[key] !== null) sorted[key] = String(query[key]);
    });
    const response = (await RequestUtils.request({
      usePlusForSpaces: true,
      responseType: 'json',
      url: API + path,
      query: sorted,
      headers: {
        'Api-Key': API_KEY,
      },
      header_commands: [
        {
          operation: 'set',
          header: 'User-Agent',
          value: 'FastStream V' + this.version,
        },
      ],
    })).response;
    if (response?.errors) {
      throw new SearchError([].concat(response.errors).join(', '));
    }
    // A throttled or refused search answers with a message and no results ("Throttle limit
    // reached", a bad key).
    if (!Array.isArray(response?.data)) {
      throw new SearchError(typeof response?.message === 'string' ? response.message : '');
    }
    return response;
  }

  /**
   * Shows one line in place of results.
   * @param {string} text
   */
  showMessage(text) {
    const message = document.createElement('div');
    message.classList.add('subtitle-search-message');
    message.textContent = text;
    this.subui.results.replaceChildren(message);
  }

  /**
   * Shows why a search failed.
   * @param {*} e
   */
  showFailure(e) {
    console.log(e);
    this.subui.pages.replaceChildren();
    if (e?.fromApi) {
      this.showMessage(e.message ? Localize.getMessage('player_opensubtitles_error', [e.message]) :
        Localize.getMessage('player_opensubtitles_error_down'));
    } else if (!EnvUtils.isExtension()) {
      // EnvUtils, since `chrome` is not declared at all in the web build.
      this.showMessage(Localize.getMessage('player_opensubtitles_disabled'));
    } else {
      this.showMessage(Localize.getMessage('player_opensubtitles_error_down'));
    }
  }

  /**
   * Finds the title the search means, then shows its subtitles. A text search for subtitles and
   * a title search run side by side: either alone missed titles the other found
   * (SubtitleSearchTitles).
   * @param {{query: string, language: string, year: ?number, season: ?number, episode: ?number}} input
   */
  async search(input) {
    // A search started while this one waits is the one to show.
    const searchNumber = ++this.searchCount;
    this.subui.title.replaceChildren();
    this.subui.pages.replaceChildren();
    if (!input.query) {
      this.showMessage(Localize.getMessage('player_opensubtitles_noresults'));
      return;
    }
    this.showMessage(Localize.getMessage('player_opensubtitles_searching'));

    const episode = input.season !== null || input.episode !== null;
    const textSearch = {query: input.query, languages: input.language};
    const titleSearch = {query: input.query};
    if (episode) {
      Object.assign(textSearch, {type: 'episode', season_number: input.season ?? '', episode_number: input.episode ?? ''});
      titleSearch.type = 'tvshow';
    } else if (input.year) {
      textSearch.year = String(input.year);
      titleSearch.year = String(input.year);
    }
    const [subtitles, features] = await Promise.allSettled([
      this.request('subtitles', textSearch),
      this.request('features', titleSearch),
    ]);
    if (searchNumber !== this.searchCount) {
      return;
    }
    if (subtitles.status === 'rejected' && features.status === 'rejected') {
      this.showFailure(subtitles.reason);
      return;
    }

    // The other titles offered match the name at least 40 of 100: "The Bear Family and Me" for
    // "The Bear" is, "Masha and the Bear" is not.
    const chosen = chooseTitles(
        titlesFromSubtitles(subtitles.status === 'fulfilled' ? subtitles.value.data : []),
        titlesFromFeatures(features.status === 'fulfilled' ? features.value.data : [], input.language),
        {name: input.query, year: input.year, season: input.season, episode: input.episode},
    );
    if (!chosen) {
      this.showMessage(Localize.getMessage('player_opensubtitles_noresults'));
      return;
    }
    this.showTitle(chosen.best, chosen.others, input, input.language, 1).catch((e) => this.showFailure(e));
  }

  /**
   * Shows one title's subtitles, the most downloaded first, and the other titles to switch to.
   * None in the language asked for: those in every language, saying so.
   * @param {Object} title - A TitleCandidate.
   * @param {Array<Object>} others - The other titles found.
   * @param {{language: string, season: ?number, episode: ?number}} input
   * @param {string} language - The language to ask for ('' for all).
   * @param {number} page
   */
  async showTitle(title, others, input, language, page) {
    const searchNumber = ++this.searchCount;
    this.showTitleHeader(title, others, input);
    this.subui.pages.replaceChildren();
    this.showMessage(Localize.getMessage('player_opensubtitles_searching'));

    let response;
    let everyLanguage = false;
    try {
      response = await this.request('subtitles', titleQuery(title, {language, season: input.season, episode: input.episode, page}));
      if (!response.data.length && language && page === 1) {
        response = await this.request('subtitles', titleQuery(title, {season: input.season, episode: input.episode}));
        everyLanguage = true;
      }
    } catch (e) {
      if (searchNumber === this.searchCount) {
        this.showFailure(e);
      }
      return;
    }
    if (searchNumber !== this.searchCount) {
      return;
    }

    this.subui.results.replaceChildren();
    if (!response.data.length) {
      this.showMessage(Localize.getMessage('player_opensubtitles_noresults'));
      return;
    }
    if (everyLanguage) {
      const notice = document.createElement('div');
      notice.classList.add('subtitle-search-message');
      notice.textContent = Localize.getMessage('player_opensubtitles_other_languages', [language]);
      this.subui.results.appendChild(notice);
      language = '';
    }
    response.data.forEach((item) => this.addResult(item));

    if (response.total_pages > 1) {
      this.subui.pages.appendChild(createPagesBar(response.page || page, response.total_pages, (next) => {
        this.showTitle(title, others, input, language, next).catch((e) => this.showFailure(e));
      }));
    }
  }

  /**
   * The title the results are for, and the other titles found, one click away.
   * @param {Object} title
   * @param {Array<Object>} others
   * @param {{language: string, season: ?number, episode: ?number}} input
   */
  showTitleHeader(title, others, input) {
    const header = this.subui.title;
    header.replaceChildren();
    const name = document.createElement('div');
    name.classList.add('subtitle-search-title-name');
    const episode = title.kind === 'show' && (input.season !== null || input.episode !== null) ?
      ' - ' + (input.season !== null ? 'S' + String(input.season).padStart(2, '0') : '') +
      (input.episode !== null ? 'E' + String(input.episode).padStart(2, '0') : '') : '';
    name.textContent = titleLabel(title) + episode;
    header.appendChild(name);
    if (!others.length) {
      return;
    }
    const list = document.createElement('div');
    list.classList.add('subtitle-other-titles');
    const label = document.createElement('span');
    label.textContent = Localize.getMessage('player_opensubtitles_other_titles');
    list.appendChild(label);
    others.forEach((other) => {
      const button = WebUtils.create('div', null, 'textbutton subtitle-other-title');
      button.textContent = titleLabel(other);
      WebUtils.setupTabIndex(button);
      button.addEventListener('click', () => {
        this.showTitle(other, [title, ...others.filter((candidate) => candidate !== other)], input, input.language, 1)
            .catch((e) => this.showFailure(e));
      });
      list.appendChild(button);
    });
    header.appendChild(list);
  }

  /**
   * One subtitle of the results: its release name (which version of the video it was made
   * for), how often it was downloaded, and what kind it is. A click loads it.
   * @param {Object} item - A subtitle from the API.
   */
  addResult(item) {
    // One result without a file to download ended the list there.
    if (!item?.attributes?.files?.length) {
      return;
    }
    const shown = describeSubtitle(item.attributes);

    const container = document.createElement('div');
    container.classList.add('subtitle-result-container');
    this.subui.results.appendChild(container);

    const lang = document.createElement('div');
    lang.classList.add('subtitle-result-lang');
    lang.textContent = shown.language;
    container.appendChild(lang);

    const text = document.createElement('div');
    text.classList.add('subtitle-result-text');
    container.appendChild(text);

    const release = document.createElement('div');
    release.classList.add('subtitle-result-title');
    release.textContent = shown.release;
    release.title = shown.release;
    text.appendChild(release);

    const meta = document.createElement('div');
    meta.classList.add('subtitle-result-meta');
    const parts = [Localize.getMessage('player_opensubtitles_downloads', [shown.downloads.toLocaleString()])];
    if (shown.fps) parts.push(`${shown.fps} fps`);
    if (shown.uploader) parts.push(shown.uploader);
    meta.textContent = parts.join(' · ');
    const badge = (key, short) => {
      const element = document.createElement('span');
      element.classList.add('subtitle-result-badge');
      element.textContent = short;
      WebUtils.setLabels(element, Localize.getMessage(key));
      meta.appendChild(element);
    };
    if (shown.hearingImpaired) badge('player_opensubtitles_hearing_impaired', 'HI');
    if (shown.machine) badge('player_opensubtitles_machine_translated', 'MT');
    if (shown.trusted) badge('player_opensubtitles_trusted', '✓');
    text.appendChild(meta);

    WebUtils.setupTabIndex(container);
    container.addEventListener('click', () => this.download(item));
  }

  /**
   * Downloads a subtitle and adds it to the video.
   * @param {Object} item - A subtitle from the API.
   */
  async download(item) {
    const details = item.attributes.feature_details || {};
    let body;
    if (item.downloading) {
      return;
    }

    item.downloading = true;
    const generation = this.downloadGeneration;

    AlertPolyfill.toast('info', Localize.getMessage('player_subtitles_addtrack_downloading'));

    try {
      let link = item.cached_download_link;
      if (!link) {
        const data = (await RequestUtils.request({
          type: 'POST',
          url: API + 'download',
          responseType: 'json',
          headers: {
            'Api-Key': API_KEY,
            'Content-Type': 'application/json',
          },

          header_commands: [
            {
              operation: 'set',
              header: 'User-Agent',
              value: 'FastStream V' + this.version,
            },
          ],

          data: JSON.stringify({
            file_id: item.attributes.files[0].file_id,
            sub_format: 'webvtt',
          }),
        })).response;

        if (!data.link && data.remaining !== undefined && data.remaining !== null && Number(data.remaining) <= 0) {
          item.downloading = false;
          await AlertPolyfill.alert(Localize.getMessage('player_opensubtitles_quota', [data.reset_time]), 'warning');
          if (await AlertPolyfill.confirm(Localize.getMessage('player_opensubtitles_askopen'), 'question')) {
            EnvUtils.openExternalURL(item.attributes.url);
          }
          return;
        }

        if (!data.link) {
          throw new Error('No link');
        }

        // Fetched below with the extension's host permissions: any scheme and host the
        // answer named was.
        if (!SubtitleUtils.isOpenSubtitlesDownloadLink(data.link)) {
          throw new Error('Not an OpenSubtitles download link');
        }

        item.cached_download_link = data.link;
        link = data.link;
      }

      body = (await RequestUtils.request({
        url: link,
        responseType: 'arraybuffer',

        header_commands: [
          {
            operation: 'set',
            header: 'User-Agent',
            value: 'FastStream V' + this.version,
          },
        ],
      }));

      if (body.status < 200 || body.status >= 300) {
        throw new Error('Bad status code');
      }

      body = SubtitleUtils.decodeSubtitleBytes(body.response, body.getResponseHeader('Content-Type'));

      if (!body) {
        throw new Error('No body');
      }
    } catch (e) {
      console.log(e);
      // Before the check below: with the search closed during the download, the result
      // stayed "downloading" and ignored every click after.
      item.downloading = false;
      if (DOMElements.subuiContainer.style.display === 'none') return;
      await AlertPolyfill.alert(Localize.getMessage('player_opensubtitles_down_alert'), 'error');
      if (await AlertPolyfill.confirm(Localize.getMessage('player_opensubtitles_askopen'), 'question')) {
        EnvUtils.openExternalURL(item.attributes.url);
      }
      return;
    }

    item.downloading = false;
    // The subtitles were cleared for another video meanwhile: these were for the one
    // before, and were added to the new one, and turned on.
    if (generation !== this.downloadGeneration) {
      return;
    }
    try {
      const name = [item.attributes.uploader?.name, details.movie_name].filter(Boolean).join(' - ') || 'OpenSubtitles';
      const track = new SubtitleTrack(name, item.attributes.language);
      track.loadText(body);
      track.checkHasCues();
      this.emit(OpenSubtitlesSearchEvents.TRACK_DOWNLOADED, track);
      AlertPolyfill.toast('success', Localize.getMessage('player_subtitles_addtrack_success'));
    } catch (e) {
      AlertPolyfill.toast('error', Localize.getMessage('player_subtitles_addtrack_error'), e?.message);
    }
  }

  /**
   * Fills the search in from what the tab's title tells (MediaTitle.guessMediaInfo).
   * @param {?{name?: string, year?: ?number, season?: ?number, episode?: ?number}} info
   */
  setMediaInfo(info) {
    if (!info) {
      return;
    }

    if (info.name) {
      this.subui.search.value = info.name;
    }
    this.subui.yearInput.value = info.year ?? '';
    this.subui.seasonInput.value = info.season ?? '';
    this.subui.episodeInput.value = info.episode ?? '';
  }

  setLanguageInputValue(value) {
    this.subui.languageInput.value = value;
  }
}
