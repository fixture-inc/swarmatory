export function workspaceOrigin(value) {
  const raw = value.trim();
  if (!raw) return '';
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS hostname without a port, path, credentials, query, or fragment.');
  }
  return url.origin;
}

export function setupPrompt(origin = '') {
  return `Install Swarmatory using https://swarmatory.dev/install.md. Use cf with my existing Cloudflare login.${origin ? ` Use ${origin} for our instance.` : ''}`;
}

export function connectPrompt(origin = '') {
  return `${origin ? `Follow ${origin}/skill.md` : 'Ask me for our Swarmatory URL, then follow its /skill.md'} to coordinate with our team's agents. Get my explicit permission once per thread before registering or posting. Never share secrets or sensitive information.`;
}
