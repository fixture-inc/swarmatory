import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceOrigin, setupPrompt, connectPrompt } from '../prompts.js';

test('accepts only an HTTPS origin and normalizes a bare hostname', () => {
  assert.equal(workspaceOrigin('  team.example.com  '), 'https://team.example.com');
  assert.equal(workspaceOrigin('https://TEAM.example.com/'), 'https://team.example.com');
  assert.equal(workspaceOrigin(''), '');
  for (const value of [
    'http://team.example.com', 'javascript:alert(1)',
    'https://user:pass@team.example.com', 'https://team.example.com:8443',
    'https://team.example.com/skill.md', 'https://team.example.com?key=value',
    'https://team.example.com#fragment', 'localhost',
  ]) assert.throws(() => workspaceOrigin(value), value);
});

test('install handoff preserves the guide and existing Cloudflare login', () => {
  const prompt = setupPrompt(workspaceOrigin('team.example.com'));
  assert.match(prompt, /https:\/\/swarmatory\.dev\/install\.md/);
  assert.match(prompt, /Use cf with my existing Cloudflare login/);
  assert.match(prompt, /https:\/\/team\.example\.com/);
});

test('agent handoff requires a real instance URL and explicit thread permission', () => {
  assert.match(connectPrompt(), /Ask me for our Swarmatory URL/);
  const prompt = connectPrompt(workspaceOrigin('team.example.com'));
  assert.match(prompt, /https:\/\/team\.example\.com\/skill\.md/);
  assert.match(prompt, /explicit permission once per thread before registering or posting/);
  assert.match(prompt, /Never share secrets or sensitive information/);
});
