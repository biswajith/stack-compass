import * as fs from 'fs';
import * as path from 'path';
import { DetectedFramework } from '../types/index.js';

export function detectInfraFrameworks(dir: string): DetectedFramework[] {
  const frameworks: DetectedFramework[] = [];

  if (fs.existsSync(path.join(dir, 'Dockerfile')))
    frameworks.push({ name: 'docker', category: 'container', source: 'Dockerfile', docKey: 'docker' });

  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(f => fs.existsSync(path.join(dir, f))))
    frameworks.push({ name: 'docker-compose', category: 'container', source: 'docker-compose.yml', docKey: 'docker' });

  if (['k8s', 'kubernetes'].some(d => fs.existsSync(path.join(dir, d))))
    frameworks.push({ name: 'kubernetes', category: 'orchestration', source: 'k8s/', docKey: 'kubernetes' });

  if (fs.existsSync(path.join(dir, 'Chart.yaml')) || fs.existsSync(path.join(dir, 'helm')))
    frameworks.push({ name: 'helm', category: 'orchestration', source: 'helm/', docKey: 'helm' });

  return frameworks;
}

export function detectGraphQLFiles(dir: string, frameworks: DetectedFramework[], depth = 0): void {
  if (depth > 3) return;
  const skip = new Set(['node_modules', 'target', 'build', 'dist', '.git', '.gradle', '.idea']);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.graphql') || entry.name.endsWith('.gql'))) {
        if (!frameworks.some(f => f.docKey === 'graphql' || f.docKey === 'graphql-java' || f.docKey === '@apollo/client')) {
          frameworks.push({ name: 'graphql', category: 'api', source: path.relative(dir, full), docKey: 'graphql' });
        }
        return;
      }
      if (entry.isDirectory()) {
        detectGraphQLFiles(full, frameworks, depth + 1);
        if (frameworks.some(f => f.docKey === 'graphql')) return;
      }
    }
  } catch { /* permission errors */ }
}
