// The dialect registry: who we present ourselves as, and exactly how well-sourced
// each identity is.
//
// RAIL (charter, non-negotiable): we do not impersonate. Every vendor-derived
// user-agent carries an appended, human-readable disclosure naming this project
// and stating we are not the vendor. See METHODOLOGY.md for why that is both the
// honest choice and a measurable limitation of the instrument.
//
// `ua_provenance` exists so that no field in this file ever has to be guessed.
// If a vendor does not publish a full UA string, we say so here rather than
// inventing a plausible one.

const DISCLOSURE = '[canireach.ai measurement probe; not the named vendor; +https://canireach.ai/bot]';

export const PROBE_CONTACT = 'https://canireach.ai/bot';

export const DIALECTS = [
  {
    id: 'browser',
    kind: 'human-baseline',
    // What an ordinary human visitor looks like. The control: if this is blocked
    // too, the block is not about agents.
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    robots_token: '*',
    disclosed: false,
    ua_provenance: 'common desktop Chrome UA; not vendor-specific, no identity claimed',
  },
  {
    id: 'curl',
    kind: 'naive-script',
    // The most common thing an unsophisticated agent actually sends.
    ua: 'curl/8.7.1',
    robots_token: '*',
    disclosed: false,
    ua_provenance: 'default UA of curl 8.7.1 as shipped on macOS',
  },
  {
    id: 'canireach',
    kind: 'self-identified-agent',
    // The honest newcomer: an agent that says who it is and where to complain.
    // This is the traveler's seat, and the row we care most about.
    ua: `CanIReachBot/0.1 (+${PROBE_CONTACT})`,
    robots_token: 'CanIReachBot',
    disclosed: true,
    ua_provenance: 'ours',
  },
  {
    id: 'gptbot',
    kind: 'vendor-token-disclosed',
    ua: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot ${DISCLOSURE}`,
    robots_token: 'GPTBot',
    disclosed: true,
    ua_provenance:
      'UA string published by OpenAI at https://developers.openai.com/api/docs/bots (read 2026-08-22), with disclosure appended',
  },
  {
    id: 'claudebot',
    kind: 'vendor-token-disclosed',
    ua: `Mozilla/5.0 (compatible; ClaudeBot/1.0) ${DISCLOSURE}`,
    robots_token: 'ClaudeBot',
    disclosed: true,
    ua_provenance:
      'robots.txt token published by Anthropic at support.claude.com article 8896518 (read 2026-08-22); Anthropic does NOT publish a full UA string there, so the surrounding string is our own construction and is not claimed to match real ClaudeBot traffic',
  },
];

// Fetched once per domain, not once per dialect. Uses our own identity.
export const SITE_FILES = [
  { id: 'robots', path: '/robots.txt' },
  { id: 'llms_txt', path: '/llms.txt' },
  { id: 'agents_md', path: '/agents.md' },
  { id: 'wellknown_agents', path: '/.well-known/agents.md' },
  // Web Bot Auth: the signed-agent identity standard (draft-meunier-web-bot-auth).
  // A site publishing this directory is signalling it will verify signed agents.
  { id: 'web_bot_auth', path: '/.well-known/http-message-signatures-directory' },
];
