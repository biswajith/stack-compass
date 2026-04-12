import { isAllowedUrl } from '../../src/fetcher/index.js';
import { assert } from '../helpers.js';

export function testUrlFetcher() {
  console.log('\n── Unit: url-fetcher (isAllowedUrl — domain allowlist) ──');

  testAllowedDocDomains();
  testBlockedProtocols();
  testBlockedDomains();
  testSSRFBypasses();
  testSubdomainMatching();
  testEdgeCases();
}

function testAllowedDocDomains() {
  console.log('  Known documentation domains allowed...');

  assert('github.com', isAllowedUrl('https://github.com/spring-projects/spring-boot'));
  assert('raw.githubusercontent.com', isAllowedUrl('https://raw.githubusercontent.com/foo/bar/main/README.md'));
  assert('api.github.com', isAllowedUrl('https://api.github.com/repos/foo/bar'));
  assert('docs.spring.io', isAllowedUrl('https://docs.spring.io/spring-boot/reference/'));
  assert('react.dev', isAllowedUrl('https://react.dev/learn'));
  assert('nextjs.org', isAllowedUrl('https://nextjs.org/llms.txt'));
  assert('tailwindcss.com', isAllowedUrl('https://tailwindcss.com/llms.txt'));
  assert('www.postgresql.org', isAllowedUrl('https://www.postgresql.org/docs/16/tutorial.html'));
  assert('dev.mysql.com', isAllowedUrl('https://dev.mysql.com/doc/refman/8.0/en/'));
  assert('hibernate.org', isAllowedUrl('https://hibernate.org/orm/documentation/'));
  assert('kubernetes.io', isAllowedUrl('https://kubernetes.io/docs/'));
  assert('redis.io', isAllowedUrl('https://redis.io/docs/'));
  assert('graphql.org', isAllowedUrl('https://graphql.org/learn/'));
  assert('docs.docker.com', isAllowedUrl('https://docs.docker.com/engine/'));
  assert('docs.scala-lang.org', isAllowedUrl('https://docs.scala-lang.org/'));
  assert('junit.org', isAllowedUrl('https://junit.org/junit5/'));
  assert('maven.apache.org', isAllowedUrl('https://maven.apache.org/'));
  assert('gradle.org', isAllowedUrl('https://gradle.org/'));
  assert('docs.gradle.org', isAllowedUrl('https://docs.gradle.org/'));
  assert('www.mongodb.com', isAllowedUrl('https://www.mongodb.com/docs/'));
}

function testBlockedProtocols() {
  console.log('  Non-HTTP(S) protocols blocked...');

  assert('ftp blocked', !isAllowedUrl('ftp://github.com/file'));
  assert('file blocked', !isAllowedUrl('file:///etc/passwd'));
  assert('gopher blocked', !isAllowedUrl('gopher://github.com'));
  assert('javascript blocked', !isAllowedUrl('javascript:alert(1)'));
}

function testBlockedDomains() {
  console.log('  Unknown/internal domains blocked...');

  assert('evil.com', !isAllowedUrl('https://evil.com/steal-data'));
  assert('example.com', !isAllowedUrl('https://example.com'));
  assert('random-docs.io', !isAllowedUrl('https://random-docs.io/'));
  assert('internal-docs.mycompany.com', !isAllowedUrl('https://internal-docs.mycompany.com/api'));
  assert('wiki.corp.net', !isAllowedUrl('https://wiki.corp.net/docs'));
  assert('malicious-docs.spring.io.evil.com', !isAllowedUrl('https://malicious-docs.spring.io.evil.com/'));
}

function testSSRFBypasses() {
  console.log('  All SSRF bypass vectors blocked...');

  // IP addresses — none are in the allowlist
  assert('localhost', !isAllowedUrl('http://localhost/'));
  assert('127.0.0.1', !isAllowedUrl('http://127.0.0.1/'));
  assert('10.0.0.1', !isAllowedUrl('http://10.0.0.1/'));
  assert('192.168.1.1', !isAllowedUrl('http://192.168.1.1/'));
  assert('169.254.169.254 (AWS IMDS)', !isAllowedUrl('http://169.254.169.254/latest/meta-data/'));
  assert('0.0.0.0', !isAllowedUrl('http://0.0.0.0/'));

  // IPv6
  assert('[::1]', !isAllowedUrl('http://[::1]/'));
  assert('[::ffff:127.0.0.1]', !isAllowedUrl('http://[::ffff:127.0.0.1]/'));
  assert('[::ffff:7f00:1] (hex-form bypass)', !isAllowedUrl('http://[::ffff:7f00:1]/'));
  assert('[fe80::1]', !isAllowedUrl('http://[fe80::1]/'));
  assert('[fc00::1]', !isAllowedUrl('http://[fc00::1]/'));
  assert('[fd00::1]', !isAllowedUrl('http://[fd00::1]/'));

  // DNS rebinding
  assert('127.0.0.1.nip.io', !isAllowedUrl('http://127.0.0.1.nip.io/'));
  assert('localhost.localdomain', !isAllowedUrl('http://localhost.localdomain/'));
  assert('spoofed.github.com.evil.com', !isAllowedUrl('https://spoofed.github.com.evil.com/'));

  // Cloud metadata
  assert('metadata.google.internal', !isAllowedUrl('http://metadata.google.internal/'));
}

function testSubdomainMatching() {
  console.log('  Subdomain matching works correctly...');

  assert('subdomain of github.com', isAllowedUrl('https://pages.github.com/'));
  assert('deep subdomain of spring.io', isAllowedUrl('https://deep.sub.spring.io/docs'));
  assert('github.com.evil.com is NOT github.com', !isAllowedUrl('https://github.com.evil.com/'));
  assert('notgithub.com is NOT github.com', !isAllowedUrl('https://notgithub.com/'));
}

function testEdgeCases() {
  console.log('  Edge cases...');

  assert('invalid URL', !isAllowedUrl('not-a-url'));
  assert('empty string', !isAllowedUrl(''));
  assert('URL with port (allowed domain)', isAllowedUrl('https://github.com:443/foo'));
  assert('URL with auth (allowed domain)', isAllowedUrl('https://user:pass@github.com/foo'));
  assert('http (not https) on allowed domain', isAllowedUrl('http://github.com/foo'));
}
