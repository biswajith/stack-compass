import { resolveGitHubToken, gitHubAuthHeaders, _resetTokenCache } from '../../src/fetcher/index.js';
import { assert } from '../helpers.js';

export function testGitHubToken() {
  console.log('\n--- Unit: GitHub Token Resolution ---');

  // Save original env
  const origGH = process.env.GH_TOKEN;
  const origGITHUB = process.env.GITHUB_TOKEN;

  try {
    testEnvVarPriority();
    testGhTokenFirst();
    testGitHubTokenFallback();
    testNoEnvFallsBackToGh();
    testAuthHeadersShape();
    testDomainRestriction();
    testEmptyTokenIgnored();
  } finally {
    // Restore env
    if (origGH !== undefined) process.env.GH_TOKEN = origGH; else delete process.env.GH_TOKEN;
    if (origGITHUB !== undefined) process.env.GITHUB_TOKEN = origGITHUB; else delete process.env.GITHUB_TOKEN;
    _resetTokenCache();
  }
}

function testEnvVarPriority() {
  console.log('  GH_TOKEN takes priority over GITHUB_TOKEN...');
  _resetTokenCache();
  process.env.GH_TOKEN = 'test_token_primary_aaa';
  process.env.GITHUB_TOKEN = 'test_token_fallback_bbb';

  const token = resolveGitHubToken();
  assert('GH_TOKEN wins', token === 'test_token_primary_aaa');

  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

function testGhTokenFirst() {
  console.log('  GH_TOKEN env var works...');
  _resetTokenCache();
  process.env.GH_TOKEN = 'test_token_first_123456';
  delete process.env.GITHUB_TOKEN;

  const token = resolveGitHubToken();
  assert('reads GH_TOKEN', token === 'test_token_first_123456');

  delete process.env.GH_TOKEN;
}

function testGitHubTokenFallback() {
  console.log('  GITHUB_TOKEN env var as fallback...');
  _resetTokenCache();
  delete process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = 'test_token_second_789012';

  const token = resolveGitHubToken();
  assert('reads GITHUB_TOKEN', token === 'test_token_second_789012');

  delete process.env.GITHUB_TOKEN;
}

function testNoEnvFallsBackToGh() {
  console.log('  Falls back to gh CLI when no env var...');
  _resetTokenCache();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;

  // This will either find a real gh token or return null — both are valid
  const token = resolveGitHubToken();
  assert('returns string or null', token === null || typeof token === 'string');
  if (token) {
    assert('gh token is non-trivial', token.length > 10);
    console.log('    (gh CLI token found)');
  } else {
    console.log('    (no gh CLI token — OK, graceful fallback)');
  }
}

function testAuthHeadersShape() {
  console.log('  gitHubAuthHeaders returns correct shape...');
  _resetTokenCache();
  process.env.GH_TOKEN = 'test_token_headers_xyz_1234';

  const headers = gitHubAuthHeaders();
  assert('has Authorization key', 'Authorization' in headers);
  assert('Bearer format', headers['Authorization'] === 'Bearer test_token_headers_xyz_1234');

  delete process.env.GH_TOKEN;

  // Without token
  _resetTokenCache();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  // Force no gh CLI by setting a very short "token"
  process.env.GH_TOKEN = 'short';
  _resetTokenCache();

  const empty = gitHubAuthHeaders();
  assert('short token ignored — no auth header', !('Authorization' in empty));

  delete process.env.GH_TOKEN;
}

function testDomainRestriction() {
  console.log('  gitHubAuthHeaders restricts token to GitHub domains...');
  _resetTokenCache();
  process.env.GH_TOKEN = 'test_token_domain_check_abc';

  const ghHeaders = gitHubAuthHeaders('https://api.github.com/repos/foo/bar');
  assert('GitHub API gets token', 'Authorization' in ghHeaders);

  const rawHeaders = gitHubAuthHeaders('https://raw.githubusercontent.com/foo/bar/main/README.md');
  assert('raw.githubusercontent gets token', 'Authorization' in rawHeaders);

  const externalHeaders = gitHubAuthHeaders('https://evil.com/steal-token');
  assert('external domain gets NO token', !('Authorization' in externalHeaders));

  const localHeaders = gitHubAuthHeaders('http://localhost:8080/api');
  assert('localhost gets NO token', !('Authorization' in localHeaders));

  const noUrlHeaders = gitHubAuthHeaders();
  assert('no URL still returns token (backward compat)', 'Authorization' in noUrlHeaders);

  delete process.env.GH_TOKEN;
}

function testEmptyTokenIgnored() {
  console.log('  Empty/short tokens are ignored...');
  _resetTokenCache();
  process.env.GH_TOKEN = '';
  process.env.GITHUB_TOKEN = '  ';

  // Both are empty/whitespace — should be ignored
  const token = resolveGitHubToken();
  // Either null (no gh CLI) or a real gh CLI token
  assert('empty strings ignored', token === null || token.length > 10);

  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
}
