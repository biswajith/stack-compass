import { ParsedSection } from '../tree-builder/index.js';

export class MemoryCache {
  private cache = new Map<string, { sections: ParsedSection[]; timestamp: number }>();
  private ttl: number;

  constructor(ttlMs = 1000 * 60 * 30) { this.ttl = ttlMs; }

  get(key: string): ParsedSection[] | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.ttl) return entry.sections;
    return null;
  }

  set(key: string, sections: ParsedSection[]): void {
    this.cache.set(key, { sections, timestamp: Date.now() });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }
}
