// @ts-check
export class MultiRegexMatcher {
  constructor() {
    /** @type {{regex: RegExp, output: *}[]} */
    this.compiledRegexes = [];
    /** @type {{regex: string, flags: string, output: *}[]} */
    this.uncompiledRegexes = [];
  }

  clear() {
    this.compiledRegexes.length = 0;
    this.uncompiledRegexes.length = 0;
  }

  /**
   * @param {string} regex
   * @param {string} flags
   * @param {*} output
   */
  addRegex(regex, flags, output) {
    if (!regex) {
      throw new Error('Empty regex: it would match everything');
    }
    // With `g`, match() returns no groups; `y` keeps lastIndex between calls.
    flags = String(flags || '').replace(/[gy]/g, '');

    try {
      new RegExp(regex, flags);
    } catch (e) {
      throw new Error('Invalid regex: ' + regex);
    }

    for (const {regex: existingRegex, flags: existingFlags, output: existingOutput} of this.uncompiledRegexes) {
      if (existingRegex === regex && existingFlags === flags && existingOutput === output) {
        return;
      }
    }

    this.uncompiledRegexes.push({regex, flags, output});
  }

  /** Each pattern on its own, in the order added: the first that matches wins. */
  compile() {
    this.compiledRegexes.length = 0;
    for (const {regex, flags, output} of this.uncompiledRegexes) {
      this.compiledRegexes.push({regex: new RegExp(regex, flags), output});
    }
  }

  /**
   * @param {string} str
   * @return {*}
   */
  match(str) {
    for (const {regex, output} of this.compiledRegexes) {
      if (regex.test(str)) {
        return output;
      }
    }
    return null;
  }
}
