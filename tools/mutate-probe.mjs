// Vacuity guard for the probe's robots.txt retrieval tests. Harness: tools/mutate.mjs
//
// This registry exists because #19 changed the ONE rail that separates a
// measurement instrument from a scanner: what the probe does with a redirect.
// robots.txt now follows up to five, the probe target still follows none, and a
// change that quietly relaxed both would be indistinguishable from this one in
// the published aggregates. So each half is broken separately here.
//
// Run: node tools/mutate-probe.mjs

import { runMutants } from './mutate.mjs';

const MUTANTS = [
  // --- the budget, at both edges -------------------------------------------
  ['four redirects followed instead of five', 'if (chain.length > ROBOTS_MAX_REDIRECTS)', 'if (chain.length >= ROBOTS_MAX_REDIRECTS)'],
  ['redirect budget raised to fifty', 'export const ROBOTS_MAX_REDIRECTS = 5;', 'export const ROBOTS_MAX_REDIRECTS = 50;'],
  ['the hop that broke the budget goes unrecorded', 'if (chain.length > ROBOTS_MAX_REDIRECTS) return done(\'redirect-exhausted\');', 'if (chain.length > ROBOTS_MAX_REDIRECTS) { chain.pop(); return done(\'redirect-exhausted\'); }'],

  // --- the probe target must NOT have moved --------------------------------
  ['the probe target starts following redirects', "redirect: 'manual',", "redirect: 'follow',"],

  // --- guards on what we are willing to follow ------------------------------
  ['redirects to private address space are followed', 'if (isPrivateHostLiteral(target.hostname))', 'if (false && isPrivateHostLiteral(target.hostname))'],
  ['link-local (cloud metadata) stops being private', 'if (a === 169 && b === 254) return true;', 'if (false) return true;'],
  ['the private 172.16/12 range runs one octet long', 'a === 172 && b >= 16 && b <= 31', 'a === 172 && b >= 16 && b <= 32'],
  ['non-HTTP redirect schemes are followed', "if (target.protocol !== 'https:' && target.protocol !== 'http:')", 'if (false)'],
  ['a redirect with no Location is followed anyway', "if (!loc) return { refusal: 'redirect-no-location' };", 'if (false) return { refusal: null };'],
  ['redirect loops are not detected', 'if (seen.has(next.url.href)) return done(\'redirect-loop\');', 'if (false) return done(\'redirect-loop\');'],

  // --- what the row says about all of it ------------------------------------
  ['an unreachable policy stops reading as unknown', 'robots-policy-unknown-${refusal}', 'robots-${refusal}'],
  ['the robots row reports the first hop instead of the response it read', 'status: robotsRes.ok ? robotsRes.status : null,', 'status: robots.chain[0]?.status ?? (robotsRes.ok ? robotsRes.status : null),'],
  ['the chain stops recording whether a hop crossed authorities', 'cross_authority: next.url ? next.url.host !== new URL(url).host : null,', 'cross_authority: false,'],
  ['the followed chain is not published', 'redirect_chain: robots.chain,', 'redirect_chain: [],'],
  ['a followed redirect stops being reported as one', 'redirected: robots.hops > 0,', 'redirected: false,'],
  ['the answering authority is not recorded', 'final_host: safeHost(robots.final_url),', 'final_host: safeHost(`https://${domain}/robots.txt`),'],
];

process.exit(runMutants({ module: 'probe.mjs', suite: 'test-probe.mjs', mutants: MUTANTS }));
