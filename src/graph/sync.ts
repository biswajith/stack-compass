import * as fs from 'fs';
import * as crypto from 'crypto';
import type { GraphStore } from './store.js';

export interface StaleInfo {
  changed: string[];
  deleted: string[];
  count: number;
}

/**
 * Detects changed/deleted files in the graph by comparing stored SHA-256 hashes
 * against current file content on disk.
 */
export class IncrementalSync {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  /**
   * Single-pass scan: detects changed and deleted files in one iteration.
   */
  getStaleInfo(): StaleInfo {
    const changed: string[] = [];
    const deleted: string[] = [];
    const files = this.store.getAllFiles();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (currentHash !== file.hash) {
          changed.push(file.path);
        }
      } catch {
        deleted.push(file.path);
      }
    }

    return { changed, deleted, count: changed.length + deleted.length };
  }

  detectChangedFiles(): string[] {
    return this.getStaleInfo().changed;
  }

  detectDeletedFiles(): string[] {
    return this.getStaleInfo().deleted;
  }

  removeDeletedFiles(): void {
    const files = this.store.getAllFiles();

    for (const file of files) {
      if (!fs.existsSync(file.path)) {
        this.store.deleteFile(file.id);
      }
    }
  }

  getStaleFileCount(): number {
    return this.getStaleInfo().count;
  }
}
