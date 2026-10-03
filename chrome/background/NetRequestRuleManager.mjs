/**
 * The URL as Firefox requests it: a raw "é" or space goes out percent-encoded. The rule has
 * to match that form, and Firefox refuses a rule whose urlFilter is not ASCII.
 * @param {string} url - The URL as the player has it.
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
 * The extension's own host in its moz-extension:// URLs, which is what Firefox matches
 * initiatorDomains against for its pages' requests.
 * @return {string}
 */
function extensionHost() {
  return new URL(chrome.runtime.getURL('/')).hostname;
}

export class RuleEntry {
  constructor(id) {
    this.id = id;
    this.expiresAt = Date.now() + 1000 * 5;
  }
}

export class RuleManager {
  constructor() {
    this.idStart = 10 + Math.floor(Math.random() * 1000) * 1000;
    this.rules = [];
    this.isLoopRunning = false;
    this.dumpRules().catch((e) => console.warn('Could not clear the header rules left from before', e));
  }

  getInsertionIndex(id) {
    // use binary search
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
    const removed = [];
    this.rules = this.rules.filter((rule) => {
      if (rule.expiresAt < now) {
        removed.push(rule);
        return false;
      }
      return true;
    });

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: removed.map((rule) => rule.id),
      });
    } catch (e) {
      // The browser may still hold them. Back in the list, their ids are not handed out
      // again (getNextID), which a new rule would be refused for, and the next round tries
      // again - three times, then they are given up.
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

  async addHeaderRule(url, tabId, requestHeaderCommands) {
    const rule = new RuleEntry(this.getNextID());
    // insert rule in order
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
        // The URL itself, unescaped: urlFilter has no escape character. A `\`
        // is a literal character to match (Firefox's CompiledUrlFilter in
        // ExtensionDNR.sys.mjs; Chrome documents only * | || ^), so escaping
        // a `*` made the rule demand a backslash no URL has, and a stream URL
        // like an Akamai `acl=/*` token got no Referer/Origin. Unescaped, a
        // `*`, `^` or `|` from the URL can only widen the match, never exclude
        // the URL itself, and the rule is limited to one tab and 5 seconds.
        // Only the scheme at the start: an http URL whose query holds an https one
        // lost that "https://" instead.
        urlFilter: '||' + asRequested(url).replace(/^https?:\/\//, ''),
        tabIds: [tabId],
        // Only the extension's own requests (the player, the background). The tab is
        // the page's too, and without this the page's own requests to that URL got the
        // player's Origin, Referer or Cookie for those 5 seconds.
        initiatorDomains: [extensionHost()],
      },
    };

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [ruleObj],
      });
    } catch (e) {
      // Roll back the optimistic insertion above so bookkeeping
      // (getNextID/getInsertionIndex) doesn't think a rule exists that the
      // browser never actually registered.
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

