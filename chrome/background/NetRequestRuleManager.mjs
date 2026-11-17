// @ts-check
/**
 * Firefox sends a raw "é" or space percent-encoded, and refuses a urlFilter that is not ASCII.
 * @param {string} url
 * @return {string}
 */
function asRequested(url) {
  try {
    return new URL(url).href;
  } catch (e) {
    return url;
  }
}

/**
 * What Firefox matches initiatorDomains against for the extension's own requests.
 * @return {string}
 */
function extensionHost() {
  return new URL(chrome.runtime.getURL('/')).hostname;
}

// A rule's request goes out at once.
export const RULE_LIFETIME_MS = 5000;
// Firefox's own player (DirectVideoPlayer) requests whenever it needs, and renews its rule.
export const MAX_RULE_LIFETIME_MS = 60000;

export class RuleEntry {
  /**
   * @param {number} id
   * @param {number} [lifetimeMs]
   */
  constructor(id, lifetimeMs) {
    this.id = id;
    this.expiresAt = Date.now() + RuleEntry.lifetime(lifetimeMs);
  }

  /**
   * @param {number} [lifetimeMs]
   * @return {number}
   */
  static lifetime(lifetimeMs) {
    const lifetime = Number.isFinite(lifetimeMs) ? /** @type {number} */ (lifetimeMs) : RULE_LIFETIME_MS;
    return Math.min(Math.max(lifetime, RULE_LIFETIME_MS), MAX_RULE_LIFETIME_MS);
  }
}

/** @typedef {RuleEntry & {removeAttempts?: number, key?: string, ready?: Promise<boolean>}} HeldRule */

export class RuleManager {
  constructor() {
    this.idStart = 10 + Math.floor(Math.random() * 1000) * 1000;
    // By id, ascending (getInsertionIndex).
    /** @type {Array<HeldRule>} */
    this.rules = [];
    this.isLoopRunning = false;
    // Rules a last event page left go first: a new rule with one of their ids would be removed with them.
    this.initialClear = this.dumpRules().catch((e) => console.warn('Could not clear the header rules left from before', e));
  }

  /**
   * @param {number} id
   * @return {number}
   */
  getInsertionIndex(id) {
    let min = 0;
    let max = this.rules.length - 1;
    let mid = 0;
    while (min <= max) {
      mid = Math.floor((min + max) / 2);
      if (this.rules[mid].id < id) {
        min = mid + 1;
      } else if (this.rules[mid].id > id) {
        max = mid - 1;
      } else {
        return -1;
      }
    }
    return min;
  }

  startLoop() {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    this.mainLoop();
  }

  mainLoop() {
    if (this.rules.length === 0) {
      this.isLoopRunning = false;
      return;
    }
    setTimeout(() => this.mainLoop(), 1000);
    this.filterRules().catch((e) => console.warn('Could not remove expired header rules', e));
  }

  async filterRules() {
    const now = Date.now();
    /** @type {Array<HeldRule>} */
    const removed = [];
    this.rules = this.rules.filter((rule) => {
      if (rule.expiresAt < now) {
        removed.push(rule);
        return false;
      }
      return true;
    });
    if (removed.length === 0) return;

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: removed.map((rule) => rule.id),
      });
    } catch (e) {
      // The browser may still hold them: their ids stay taken, and the next round tries again (three times).
      for (const rule of removed) {
        rule.removeAttempts = (rule.removeAttempts || 0) + 1;
        const index = this.getInsertionIndex(rule.id);
        if (rule.removeAttempts < 3 && index !== -1) {
          this.rules.splice(index, 0, rule);
        }
      }
      this.startLoop();
      throw e;
    }
  }

  /**
   * @param {string} url
   * @param {number} tabId
   * @param {FSHeaderCommand[]} requestHeaderCommands
   * @param {number} [lifetimeMs]
   */
  async addHeaderRule(url, tabId, requestHeaderCommands, lifetimeMs) {
    await this.initialClear;
    // The same rule still held is kept longer instead of added again, once the browser has taken it.
    const key = JSON.stringify([asRequested(url), tabId, requestHeaderCommands]);
    const same = this.rules.find((held) => held.key === key && !held.removeAttempts && held.expiresAt > Date.now());
    if (same && await same.ready && this.rules.includes(same) && same.expiresAt > Date.now()) {
      same.expiresAt = Math.max(same.expiresAt, Date.now() + RuleEntry.lifetime(lifetimeMs));
      return same;
    }

    /** @type {HeldRule} */
    const rule = new RuleEntry(this.getNextID(), lifetimeMs);
    rule.key = key;
    const index = this.getInsertionIndex(rule.id);
    if (index === -1) throw new Error('Rule already exists');
    this.rules.splice(index, 0, rule);

    const ruleObj = {
      id: rule.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: requestHeaderCommands,
      },
      condition: {
        // urlFilter has no escape character, so the URL goes unescaped; a trailing `|` would anchor the end.
        urlFilter: '||' + asRequested(url).replace(/^https?:\/\//, '').replace(/\|$/, '|*'),
        tabIds: [tabId],
        // Only the extension's own requests: the tab is the page's too.
        initiatorDomains: [extensionHost()],
      },
    };

    // Removed first, in the same call: a given-up rule's id may still be held by the browser.
    const added = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleObj.id],
      addRules: /** @type {chrome.declarativeNetRequest.Rule[]} */ ([ruleObj]),
    });
    rule.ready = added.then(() => true, () => false);
    try {
      await added;
    } catch (e) {
      const rollbackIndex = this.rules.indexOf(rule);
      if (rollbackIndex !== -1) this.rules.splice(rollbackIndex, 1);
      throw e;
    }

    this.startLoop();
    return rule;
  }

  getNextID() {
    let nextRuleID = this.idStart;
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.id === nextRuleID) {
        nextRuleID++;
      } else {
        break;
      }
    }
    return nextRuleID;
  }

  async dumpRules() {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    return chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((rule) => rule.id),
    });
  }
}

