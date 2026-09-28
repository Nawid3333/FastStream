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

  compile() {
    const regexesByFlags = new Map();
    for (const {regex, flags, output} of this.uncompiledRegexes) {
      if (!regexesByFlags.has(flags)) {
        regexesByFlags.set(flags, []);
      }

      regexesByFlags.get(flags).push({regex, output});
    }


    this.compiledRegexes.length = 0;

    regexesByFlags.forEach((regexes, flags) => {
      const regexesByOutput = new Map();
      for (const {regex, output} of regexes) {
        if (!regexesByOutput.has(output)) {
          regexesByOutput.set(output, []);
        }
        regexesByOutput.get(output).push(regex);
      }

      const joinedRegexes = [];
      const outputByGroupName = new Map();
      let groupIndex = 0;
      regexesByOutput.forEach((regexes, output) => {
        // Named group, not a plain wrapping group: a raw regex with its own
        // capturing group(s) would otherwise shift every later output's
        // positional group index, silently misrouting the match to the
        // wrong (or a nonexistent) output.
        const groupName = 'o' + groupIndex++;
        outputByGroupName.set(groupName, output);
        joinedRegexes.push(`(?<${groupName}>${regexes.join('|')})`);
      });

      this.compiledRegexes.push({
        regex: new RegExp(joinedRegexes.join('|'), flags),
        outputByGroupName,
      });
    });
  }

  match(str) {
    for (const {regex, outputByGroupName} of this.compiledRegexes) {
      const match = str.match(regex);
      if (match?.groups) {
        for (const groupName in match.groups) {
          if (match.groups[groupName] !== undefined) {
            return outputByGroupName.get(groupName);
          }
        }
      }
    }
    return null;
  }
}
