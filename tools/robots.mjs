// A robots.txt parser following RFC 9309.
//
// This is the highest-value layer of the whole probe: unlike a live request, a
// policy verdict is independent of our IP address, so it is the one thing we can
// measure with full accuracy from anywhere. That also makes it the most dangerous
// thing to get wrong quietly, which is why test-robots.mjs exists and why it is
// checked for vacuity.

/**
 * Parse robots.txt into groups. Consecutive User-agent lines share the rules
 * that follow them (RFC 9309 s2.2.1).
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let expectingAgents = false; // are we still collecting the agent list of `current`?

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (!current) continue; // rule before any user-agent: not in any group
      expectingAgents = false;
      current.rules.push({ type: field, path: value });
      continue;
    }
    // crawl-delay, sitemap, host and unknown fields do not close an agent list
    // for our purposes; sitemap is global anyway.
    if (field === 'crawl-delay' && current) {
      expectingAgents = false;
      current.crawlDelay = value;
    }
  }
  return groups;
}

/**
 * Pick the group for a token. RFC 9309 s2.2.1: match is case-insensitive on the
 * product token, and the most specific (longest) matching name wins. `*` is the
 * fallback and only applies when no specific group matched.
 */
export function selectGroup(groups, token) {
  const want = String(token).toLowerCase();
  let best = null;
  let bestLen = -1;
  let wildcard = null;

  for (const g of groups) {
    let groupBestLen = -1;
    for (const a of g.agents) {
      if (a === '*') {
        // Merge multiple wildcard groups rather than letting a later empty one win.
        if (!wildcard) wildcard = { agents: ['*'], rules: [] };
        wildcard.rules.push(...g.rules);
        continue;
      }
      // A robots.txt token matches if it is a prefix of our product token
      // (so `Claude` matches `ClaudeBot`), per common implementation practice.
      if (want === a || want.startsWith(a)) {
        groupBestLen = Math.max(groupBestLen, a.length);
      }
    }

    if (groupBestLen > bestLen) {
      best = { agents: [...g.agents], rules: [...g.rules] };
      bestLen = groupBestLen;
    } else if (groupBestLen >= 0 && groupBestLen === bestLen) {
      // RFC 9309 requires all equally specific matching groups to be combined.
      // Keeping only the first can hide a later Disallow and probe past a no.
      best.agents.push(...g.agents);
      best.rules.push(...g.rules);
    }
  }
  return best || wildcard || null;
}

/** Does a robots.txt path pattern match a url path? Supports `*` and `$`. */
export function pathMatches(pattern, path) {
  if (pattern === '') return false; // empty Disallow means "nothing is disallowed"
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '$' && i === pattern.length - 1) re += '$';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + re).test(path);
  } catch {
    return false;
  }
}

/**
 * Verdict for (robots.txt, token, path).
 * Returns { allowed, reason, rule, group }.
 *
 * Longest matching pattern wins; Allow wins an exact-length tie (RFC 9309 s2.2.2).
 */
export function isAllowed(text, token, path = '/') {
  const groups = parseRobots(text);
  if (groups.length === 0) return { allowed: true, reason: 'no-rules', rule: null, group: null };

  const group = selectGroup(groups, token);
  if (!group) return { allowed: true, reason: 'no-matching-group', rule: null, group: null };

  let winner = null;
  for (const rule of group.rules) {
    if (!pathMatches(rule.path, path)) continue;
    if (
      !winner ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.type === 'allow')
    ) {
      winner = rule;
    }
  }

  const groupName = group.agents.join(',');
  if (!winner) return { allowed: true, reason: 'no-matching-rule', rule: null, group: groupName };
  return {
    allowed: winner.type === 'allow',
    reason: winner.type === 'allow' ? 'allow-rule' : 'disallow-rule',
    rule: `${winner.type}: ${winner.path}`,
    group: groupName,
  };
}

/** True when a group exists that names this token explicitly (not via `*`). */
export function hasExplicitGroup(text, token) {
  const want = String(token).toLowerCase();
  for (const g of parseRobots(text)) {
    for (const a of g.agents) {
      if (a !== '*' && (want === a || want.startsWith(a))) return true;
    }
  }
  return false;
}
