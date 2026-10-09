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
<<<<<<< HEAD
    // The empty regex matches every string: added by mistake, it would route every URL
    // to this output.
    if (!regex) {
      throw new Error('Empty regex: it would match everything');
    }
    // match() needs the groups of the first match. With `g`, String.prototype.match
    // returns every match and no groups, so the pattern never matched; `y` would keep a
    // lastIndex between calls. Neither means anything for a yes/no match.
    flags = String(flags || '').replace(/[gy]/g, '');
=======
    // An empty regex matches every string
    if (!regex) {
      throw new Error('Empty regex for ' + output);
    }
>>>>>>> upstream/main

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
      // A backreference counts groups by position, and the groups the joined form adds
      // move them: \1 came to mean the group wrapped around the pattern. Such a pattern
      // is compiled on its own.
      const alone = regexes.filter(({regex}) => /\\(?:[1-9]|k<)/.test(regex));
      const joinable = regexes.filter((entry) => !alone.includes(entry));
      if (joinable.length > 0) {
        try {
          this.compiledRegexes.push(MultiRegexMatcher.join(joinable, flags));
        } catch (e) {
          // A pattern valid on its own that the joined form refuses - a group of its own
          // named like the ones added (o0) - left all of them out, and the matcher before
          // stayed in use. Each on its own instead.
          alone.push(...joinable);
        }
      }
<<<<<<< HEAD
      for (const {regex, output} of alone) {
        this.compiledRegexes.push({regex: new RegExp(regex, flags), output});
      }
=======

      // Named groups: a pattern's own capture groups would shift group positions
      const joinedRegexes = [];
      const outputs = new Map();
      regexesByOutput.forEach((regexes, output) => {
        const groupName = '__fsOutput' + outputs.size;
        joinedRegexes.push(`(?<${groupName}>` + regexes.join('|') + ')');
        outputs.set(groupName, output);
      });

      this.compiledRegexes.push({
        regex: new RegExp(joinedRegexes.join('|'), flags),
        outputs,
      });
>>>>>>> upstream/main
    });
  }

  /**
   * One regex for many patterns: each output's patterns in a named group of its own.
   * @param {Array<{regex: string, output: *}>} regexes - The patterns, all with one set
   *   of flags.
   * @param {string} flags - Those flags.
   * @return {{regex: RegExp, outputByGroupName: Map<string, *>}}
   */
  static join(regexes, flags) {
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

    return {
      regex: new RegExp(joinedRegexes.join('|'), flags),
      outputByGroupName,
    };
  }

  match(str) {
<<<<<<< HEAD
    for (const {regex, output, outputByGroupName} of this.compiledRegexes) {
      const match = str.match(regex);
      if (!match) {
        continue;
      }
      if (!outputByGroupName) {
        return output;
      }
      // By the groups this matcher added, not every group the match has: a pattern's own
      // named group came first in a match of a later output, and gave no output at all.
      for (const [groupName, groupOutput] of outputByGroupName) {
        if (match.groups?.[groupName] !== undefined) {
          return groupOutput;
=======
    for (const {regex, outputs} of this.compiledRegexes) {
      // exec() from the start: str.match() gives no groups for a g regex,
      // and g or y would carry lastIndex over from the previous call
      regex.lastIndex = 0;
      const match = regex.exec(str);
      if (match) {
        for (const [groupName, output] of outputs) {
          if (match.groups[groupName] !== undefined) {
            return output;
          }
>>>>>>> upstream/main
        }
      }
    }
    return null;
  }
}
