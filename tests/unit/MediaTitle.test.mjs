import {describe, expect, it} from 'vitest';

import {guessMediaInfo} from '../../chrome/player/utils/MediaTitle.mjs';

// What the subtitle search starts from on a streaming site: the tab's title, cleaned of what the
// site adds. Tab titles as English and German streaming sites write them.

const NOW = 2026;
const guess = (title, host) => guessMediaInfo(title, host, NOW);
const movie = (name, year = null) => ({name, year, season: null, episode: null});
const show = (name, season, episode) => ({name, year: null, season, episode});

describe('guessMediaInfo', () => {
  it.each([
    ['Watch Oppenheimer (2023) Online Free | 123movies', '123movies.com', movie('Oppenheimer', 2023)],
    ['Oppenheimer (2023) - Watch Online HD | Soap2Day', 'soap2day.to', movie('Oppenheimer', 2023)],
    ['Dune: Part Two (2024) - Watch Online HD', 'fmovies.to', movie('Dune: Part Two', 2024)],
    ['Dune Part Two 2024 Ganzer Film Deutsch | kino.to', 'kino.to', movie('Dune Part Two', 2024)],
    ['Titanic (1997) | Watch Full Movie Online Free', 'putlocker.vip', movie('Titanic', 1997)],
    ['Titanic 1997 - Stream HD', 'yesmovies.ag', movie('Titanic', 1997)],
    ['Mission: Impossible – Dead Reckoning Part One (2023) | Paramount+', 'paramountplus.com',
      movie('Mission: Impossible - Dead Reckoning Part One', 2023)],
    ['Mission: Impossible - Fallout 2018 - Watch Online', 'primevideo.com', movie('Mission: Impossible - Fallout', 2018)],
    ['Spider-Man: No Way Home (2021) | 1080p', 'hdmovies.com', movie('Spider-Man: No Way Home', 2021)],
    ['Spider-Man No Way Home 2021 HD', 'hdmovies.com', movie('Spider-Man No Way Home', 2021)],
    ['1917 (2019) - Watch Online Free', '123movies.com', movie('1917', 2019)],
    ['1917 | Stream HD', 'fmovies.to', movie('1917')],
    ['2012 (2009) - Ganzer Film Deutsch', 'kino.to', movie('2012', 2009)],
    ['2012 - Stream HD', 'streamkiste.tv', movie('2012')],
    ['Blade Runner 2049 (2017) | Watch Online', 'soap2day.to', movie('Blade Runner 2049', 2017)],
    ['Blade Runner 2049 - Watch Online HD', 'putlocker.vip', movie('Blade Runner 2049')],
    ['Ocean\'s Eleven (2001) | Watch Online Free', '123movies.com', movie('Ocean\'s Eleven', 2001)],
    ['Ocean\'s Eleven 2001 - Stream', 'fmovies.to', movie('Ocean\'s Eleven', 2001)],
    ['Die fabelhafte Welt der Amélie (2001) | Ganzer Film Deutsch', 'kino.to', movie('Die fabelhafte Welt der Amélie', 2001)],
    ['Die fabelhafte Welt der Amélie - kostenlos anschauen', 'kinox.to', movie('Die fabelhafte Welt der Amélie')],
  ])('finds the movie in %j', (title, host, expected) => {
    expect(guess(title, host)).toEqual(expected);
  });

  it.each([
    ['The Bear - S02E03 Sundae | Disney+', 'disneyplus.com', show('The Bear', 2, 3)],
    ['The Bear | Staffel 2 Folge 3 | Sundae | Disney+', 'disneyplus.com', show('The Bear', 2, 3)],
    ['Masha and the Bear - S02E03 One Hit Wonder | Netflix', 'netflix.com', show('Masha and the Bear', 2, 3)],
    ['Das Boot Staffel 2 Folge 3 | Sky', 'sky.de', show('Das Boot', 2, 3)],
    ['Dark S01E01 Geheimnisse | Netflix', 'netflix.com', show('Dark', 1, 1)],
    ['Dark 1x01 - Geheimnisse | Netflix', 'netflix.com', show('Dark', 1, 1)],
    ['One Piece - Episode 12 | Crunchyroll', 'crunchyroll.com', show('One Piece', null, 12)],
    ['One Piece Episode 12 German Sub | AniWorld', 'aniworld.to', show('One Piece', null, 12)],
    ['The Office S03E12 - The Return | Amazon Prime Video', 'primevideo.com', show('The Office', 3, 12)],
    ['Stranger Things 4x09 - The Piggyback | Netflix', 'netflix.com', show('Stranger Things', 4, 9)],
    ['Watch The Bear Season 2 Episode 3 Online', 'example.com', show('The Bear', 2, 3)],
    ['Babylon Berlin Staffel 4 | ARD Mediathek', 'ardmediathek.de', show('Babylon Berlin', 4, null)],
    ['Jujutsu Kaisen Season 2 Episode 5 English Sub', 'example.org', show('Jujutsu Kaisen', 2, 5)],
    // The marker first: cut off, not the end of the title.
    ['S02E03 - The Bear | Disney+', 'disneyplus.com', show('The Bear', 2, 3)],
  ])('finds the episode in %j', (title, host, expected) => {
    expect(guess(title, host)).toEqual(expected);
  });

  it.each([
    // Words that end or begin a title stay there; the old guess dropped "part", "show", "movie".
    ['Scary Movie (2000) Stream', 'example.com', movie('Scary Movie', 2000)],
    ['The Truman Show (1998)', 'example.com', movie('The Truman Show', 1998)],
    ['Apocalypse Now (1979) - Stream', 'example.com', movie('Apocalypse Now', 1979)],
    ['Free Guy (2021) Ganzer Film', 'example.com', movie('Free Guy', 2021)],
    ['In Time (2011) - Watch Online', 'example.com', movie('In Time', 2011)],
    ['Die Hard (1988) | Stream Deutsch', 'example.com', movie('Die Hard', 1988)],
    // No season in "Ocean's 11", no episode in "Se7en" or "E.T.".
    ['Ocean\'s 11 Stream Deutsch', 'example.com', movie('Ocean\'s 11')],
    ['Se7en (1995)', 'example.com', movie('Se7en', 1995)],
    ['E.T. the Extra-Terrestrial (1982)', 'example.com', movie('E.T. the Extra-Terrestrial', 1982)],
    // Picture words anywhere.
    ['Top Gun: Maverick 2022 4K HDR x265', 'example.com', movie('Top Gun: Maverick', 2022)],
    // Small words at the start, when only small words stand before the title's own (review,
    // 2026-10-09: these lost "In" and "For").
    ['In the Heat of the Night (1967) - Watch Online', 'example.com', movie('In the Heat of the Night', 1967)],
    ['For a Few Dollars More (1965) | Stream', 'example.com', movie('For a Few Dollars More', 1965)],
    ['Watch the free movie Oppenheimer', 'example.com', movie('Oppenheimer')],
    ['Season of the Witch (2011) Stream', 'example.com', movie('Season of the Witch', 2011)],
    ['Face/Off (1997) - Watch Online', 'example.com', movie('Face/Off', 1997)],
    // A year before a word kept at the end.
    ['Oppenheimer 2023 Movie | Watch Online', 'example.com', movie('Oppenheimer', 2023)],
    // ... also in a part of its own after the title, which kept "2023 Movie" in the name and
    // found no year (audit, 2026-10-09), but not as the title itself.
    ['Oppenheimer | 2023 Movie', 'example.com', movie('Oppenheimer', 2023)],
    ['Oppenheimer - 2023 Film', 'example.com', movie('Oppenheimer', 2023)],
    ['2012 Movie', 'example.com', movie('2012 Movie')],
  ])('keeps the title whole in %j', (title, host, expected) => {
    expect(guess(title, host)).toEqual(expected);
  });

  it('finds no title where the tab names only the site', () => {
    expect(guess('Watch Free Movies Online | FMovies', 'fmovies.to').name).toBe('');
  });

  it('takes the site name from a country domain', () => {
    expect(guess('Doctor Who - BBC iPlayer', 'www.bbc.co.uk').name).toBe('Doctor Who');
  });

  it('takes no year from the future, and copes with no title at all', () => {
    expect(guess('Avatar 2031', 'example.com')).toEqual(movie('Avatar 2031'));
    expect(guess('', '')).toEqual(movie(''));
    expect(guessMediaInfo(undefined, undefined)).toEqual(movie(''));
  });
});
