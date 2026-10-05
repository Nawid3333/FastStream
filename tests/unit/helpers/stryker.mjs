// Stryker's mutation runs (stryker.config.mjs) run the unit suite in a copy of the
// repository in which every module they mutate is rewritten: each expression wrapped in
// stryMutAct_/stryCov_ calls. A test that reads such a module as text - to check what it
// says, not what it does - cannot pass there, and it failed the run's first, unmutated pass
// (mutation-tests.yml, #349). It skips in that copy instead; in a normal run the file is the
// repository's own, and the test runs.

/**
 * Whether a module's text is Stryker's rewrite of it.
 * @param {string} source - The file's text.
 * @return {boolean}
 */
export function isMutationSandboxCopy(source) {
  return /\bstry(?:MutAct|Cov)_[0-9a-f]+\(/.test(source);
}
