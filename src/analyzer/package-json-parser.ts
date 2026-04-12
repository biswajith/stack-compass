import * as fs from 'fs';
import * as path from 'path';
import { DetectedFramework, FrameworkCategory } from '../types/index.js';
import { cleanVersion } from './helpers.js';

export function parsePackageJson(filePath: string): DetectedFramework[] {
  const frameworks: DetectedFramework[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

    const targets: Array<{ names: string[]; category: FrameworkCategory; docKey?: string }> = [
      { names: ['react', 'react-dom'], category: 'frontend' },
      { names: ['redux', '@reduxjs/toolkit'], category: 'frontend' },
      { names: ['vue'], category: 'frontend' },
      { names: ['next'], category: 'frontend' },
      { names: ['angular', '@angular/core'], category: 'frontend', docKey: 'angular' },
      { names: ['svelte'], category: 'frontend' },
      { names: ['graphql'], category: 'api' },
      { names: ['@apollo/client', 'apollo-client'], category: 'api', docKey: '@apollo/client' },
      { names: ['relay-runtime'], category: 'api' },
      { names: ['urql'], category: 'api' },
      { names: ['typescript'], category: 'build' },
      { names: ['vite'], category: 'build' },
      { names: ['webpack'], category: 'build' },
      { names: ['tailwindcss'], category: 'frontend' },
      { names: ['express'], category: 'backend' },
      { names: ['fastify'], category: 'backend' },
      { names: ['@nestjs/core'], category: 'backend', docKey: 'nestjs' },
      { names: ['jest'], category: 'testing' },
      { names: ['vitest'], category: 'testing' },
      { names: ['cypress'], category: 'testing' },
      { names: ['playwright', '@playwright/test'], category: 'testing', docKey: 'playwright' },
      { names: ['mongoose'], category: 'database' },
      { names: ['@prisma/client', 'prisma'], category: 'database', docKey: 'prisma' },
      { names: ['typeorm'], category: 'database' },
      { names: ['sequelize'], category: 'database' },
      { names: ['axios'], category: 'api' },
      { names: ['swr'], category: 'api' },
      { names: ['@tanstack/react-query'], category: 'api' },
    ];

    for (const t of targets) {
      for (const name of t.names) {
        if (allDeps[name]) {
          frameworks.push({
            name,
            version: cleanVersion(allDeps[name]),
            category: t.category,
            source: 'package.json',
            docKey: t.docKey ?? name,
          });
        }
      }
    }

    const yarnLockExists = fs.existsSync(path.join(path.dirname(filePath), 'yarn.lock'));
    const pmField = pkg.packageManager as string | undefined;
    let pmName = yarnLockExists ? 'yarn' : 'npm';
    let pmVersion: string | undefined;
    if (pmField) {
      const match = pmField.match(/^(\w+)@(.+)$/);
      if (match) { pmName = match[1]; pmVersion = match[2]; }
    }
    frameworks.push({ name: pmName, version: pmVersion, category: 'build', source: 'package.json', docKey: pmName });

  } catch { /* invalid JSON */ }
  return frameworks;
}
