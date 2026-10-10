// @ts-check
export class MultiRegexMatcher {
  constructor() {
    this.compiledRegexes = [];
    this.uncompiledRegexes = [];
  }

  clear() {
    this.compiledRegexes.length = 0;
    this.uncompiledRegexes.length = 0;
  }

  addRegex(regex, flags, output) {
    // The empty regex matches every string: added by mistake, it would route every URL
    // to this output.
    if (!regex) {
      throw new Error('Empty regex: it would match everything');
    }
    // match() needs the groups of the first match. With `g`, String.prototype.match
    // returns every match and no groups, so the pattern never matched; `y` would keep a
    // lastIndex between calls. Neither means anything for a yes/no match.
    flags = String(flags || '').replace(/[gy]/g, '');

    // check if regex is valid
    try {
      new RegExp(regex, flags);
    } catch (e) {
      throw new Error('Invalid regex: ' + regex);
    }

    // check if regex is already added
    for (const {regex: existingRegex, flags: existingFlags, output: existingOutput} of this.uncompiledRegexes) {
      if (existingRegex === regex && existingFlags === flags && existingOutput === output) {
        return;
      }
    }

    // add regex
    this.uncompiledRegexes.push({regex, flags, output});
  }

  /**
   * Each pattern on its own, in the order added: the options page says the patterns "are
   * applied in order, and the first match is used". They were joined into one regex per
   * set of flags, each output's in a group of its own, and that regex answered with the
   * pattern matching earliest in the URL: `hls /\.m3u8/` then `dash /cdn/` sent
   * https://cdn.example/a.m3u8 to dash (review). On its own, a pattern's groups,
   * backreferences and group names are its own as well, which the joined form had to work
   * around one by one.
   */
  compile() {
    this.compiledRegexes.length = 0;
    for (const {regex, flags, output} of this.uncompiledRegexes) {
      this.compiledRegexes.push({regex: new RegExp(regex, flags), output});
    }
  }

  /**
   * @param {string} str
   * @return {*} The output of the first pattern that matches, or null.
   */
  match(str) {
    for (const {regex, output} of this.compiledRegexes) {
      // Neither g nor y is kept (addRegex): test() keeps no state between calls.
      if (regex.test(str)) {
        return output;
      }
    }
    return null;
  }
}
