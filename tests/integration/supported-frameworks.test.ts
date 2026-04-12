import { setupClient, getText, assertIncludes } from '../helpers.js';

export async function testSupportedFrameworks() {
  console.log('\n── Integration: list-all-supported-frameworks ──────');
  const client = await setupClient();

  const r = getText(await client.callTool({ name: 'list-all-supported-frameworks', arguments: {} }));
  assertIncludes('Has spring-boot', r, 'spring-boot');
  assertIncludes('Has react', r, 'react');
  assertIncludes('Has graphql', r, 'graphql');
  assertIncludes('Has docker', r, 'docker');
  assertIncludes('Has scala', r, 'scala');
  assertIncludes('Has mongodb', r, 'mongodb');
  assertIncludes('Has kubernetes', r, 'kubernetes');
  assertIncludes('Has hibernate', r, 'hibernate');
  assertIncludes('Has tailwindcss', r, 'tailwindcss');
  assertIncludes('Has next', r, 'next');
  assertIncludes('Has junit', r, 'junit');
  assertIncludes('Has maven', r, 'maven');
  assertIncludes('Has gradle', r, 'gradle');

  // Category headers
  assertIncludes('Has Frontend category', r, 'Frontend');
  assertIncludes('Has Backend (Java) category', r, 'Backend (Java)');
  assertIncludes('Has Backend (Scala) category', r, 'Backend (Scala)');
  assertIncludes('Has Databases category', r, 'Databases');
  assertIncludes('Has Containers category', r, 'Containers');
  assertIncludes('Has Build Tools category', r, 'Build Tools');

  await client.close();
}
