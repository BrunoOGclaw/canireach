// Tests for the robots.txt parser.
//
// Every case here was written to be able to FAIL: each asserts a value that a
// plausible-but-wrong implementation would get wrong. `npm test`-free, zero deps.
// Run: node tools/test-robots.mjs
//
// The vacuity guard at the bottom is not decoration. A test suite for a parser is
// exactly the place where "green" can mean "asserted nothing", so the suite is
// re-run against deliberately broken copies of robots.mjs and every mutant must
// be caught by at least one case.

import { isAllowed, parseRobots, selectGroup, pathMatches, hasExplicitGroup } from './robots.mjs';

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

const allow = (txt, token, path = '/') => isAllowed(txt, token, path).allowed;

// --- group structure -------------------------------------------------------

eq(parseRobots('User-agent: A\nDisallow: /x\n').length, 1, 'one group');

eq(
  parseRobots('User-agent: A\nUser-agent: B\nDisallow: /x\n')[0].agents,
  ['a', 'b'],
  'consecutive user-agents share one group',
);

eq(
  parseRobots('User-agent: A\nDisallow: /x\nUser-agent: B\nDisallow: /y\n').length,
  2,
  'a rule closes the agent list, so the next user-agent starts a new group',
);

eq(parseRobots('Disallow: /x\nUser-agent: A\nAllow: /\n')[0].agents, ['a'], 'rules before any user-agent are dropped');

eq(parseRobots('User-agent: A # inline\nDisallow: /x # trailing\n')[0].rules, [{ type: 'disallow', path: '/x' }], 'comments stripped');

// --- selection -------------------------------------------------------------

const twoGroups = 'User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n';
eq(allow(twoGroups, 'GPTBot'), true, 'a specific group beats the wildcard group');
eq(allow(twoGroups, 'SomeoneElse'), false, 'an unlisted agent falls back to the wildcard group');

eq(
  selectGroup(parseRobots('User-agent: bot\nDisallow: /a\n\nUser-agent: bigbot\nDisallow: /b\n'), 'bigbot').rules[0].path,
  '/b',
  'longest matching agent token wins',
);

eq(allow('User-agent: claude\nDisallow: /\n', 'ClaudeBot'), false, 'a robots token that is a prefix of our token matches');
eq(allow('User-agent: GPTBOT\nDisallow: /\n', 'gptbot'), false, 'agent matching is case-insensitive');
eq(hasExplicitGroup('User-agent: *\nDisallow: /\n', 'GPTBot'), false, 'wildcard alone is not an explicit group');
eq(hasExplicitGroup(twoGroups, 'GPTBot'), true, 'named group is explicit');

// Two wildcard blocks must merge, or a trailing empty one silently wipes the rules.
eq(
  allow('User-agent: *\nDisallow: /private\n\nUser-agent: *\nCrawl-delay: 5\n', 'X', '/private'),
  false,
  'multiple wildcard groups merge rather than the last one winning',
);

// Named blocks at the same specificity merge too. Ignoring the second block can
// turn a real deny into an unattended request.
eq(
  allow('User-agent: GPTBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /private\n', 'GPTBot', '/private'),
  false,
  'multiple equally specific named groups merge',
);

// --- path rules ------------------------------------------------------------

eq(allow('User-agent: *\nDisallow:\n', 'X'), true, 'empty Disallow allows everything');
eq(allow('User-agent: *\nDisallow: /\n', 'X'), false, 'Disallow: / blocks the root');
eq(allow('User-agent: *\nDisallow: /a\n', 'X', '/b'), true, 'non-matching disallow does not block');
eq(allow('User-agent: *\nDisallow: /a\n', 'X', '/abc'), false, 'disallow is a prefix match');

eq(
  allow('User-agent: *\nDisallow: /a\nAllow: /a/b\n', 'X', '/a/b/c'),
  true,
  'longer Allow beats shorter Disallow',
);
eq(
  allow('User-agent: *\nDisallow: /a/b\nAllow: /a\n', 'X', '/a/b'),
  false,
  'longer Disallow beats shorter Allow',
);
eq(
  allow('User-agent: *\nDisallow: /x\nAllow: /x\n', 'X', '/x'),
  true,
  'Allow wins an equal-length tie',
);

eq(pathMatches('/*.pdf$', '/docs/file.pdf'), true, 'wildcard and end-anchor match');
eq(pathMatches('/*.pdf$', '/docs/file.pdf.html'), false, '$ anchors the end');
eq(pathMatches('', '/anything'), false, 'an empty pattern matches nothing');
eq(pathMatches('/a+b', '/a+b'), true, 'regex metacharacters in a path are literal');

// --- real-world shape ------------------------------------------------------

const realistic = `
# hello
User-agent: *
Disallow: /search
Allow: /search/about
Crawl-delay: 10

User-agent: GPTBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;
eq(allow(realistic, 'GPTBot'), false, 'realistic: GPTBot blocked outright');
eq(allow(realistic, 'CanIReachBot', '/search'), false, 'realistic: wildcard disallow applies');
eq(allow(realistic, 'CanIReachBot', '/search/about'), true, 'realistic: nested allow applies');
eq(allow(realistic, 'CanIReachBot', '/'), true, 'realistic: root is open to everyone else');

// --- report ----------------------------------------------------------------

if (process.env.CIR_MUTANT) {
  // Under mutation the only thing that matters is pass/fail.
  process.exit(failures.length ? 1 : 0);
}

console.log(`robots parser: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
