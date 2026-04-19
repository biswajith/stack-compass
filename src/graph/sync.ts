import * as fs from 'fs';
import * as crypto from 'crypto';
import type { GraphStore } from './store.js';

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
   * Returns file paths stored in the graph whose on-disk content has changed
   * (hash mismatch).
   */
  detectChangedFiles(): string[] {
    const changed: string[] = [];
    const files = this.store.getAllFiles();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (currentHash !== file.hash) {
          changed.push(file.path);
        }
      } catch {
        // File can't be read — might be deleted, handled separately
      }
    }

    return changed;
  }

  /**
   * Returns file paths stored in the graph that no longer exist on disk.
   */
  detectDeletedFiles(): string[] {
    const deleted: string[] = [];
    const files = this.store.getAllFiles();

    for (const file of files) {
      if (!fs.existsSync(file.path)) {
        deleted.push(file.path);
      }
    }

    return deleted;
  }

  /**
   * Removes files from the graph that no longer exist on disk.
   * CASCADE delete removes associated nodes and edges.
   */
  removeDeletedFiles(): void {
    const files = this.store.getAllFiles();

    for (const file of files) {
      if (!fs.existsSync(file.path)) {
        this.store.deleteFile(file.id);
      }
    }
  }

  /**
   * Returns the count of files in the graph whose on-disk content has changed
   * or that no longer exist.
   */
  getStaleFileCount(): number {
    let count = 0;
    const files = this.store.getAllFiles();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (currentHash !== file.hash) {
          count++;
        }
      } catch {
        count++; // Missing file counts as stale
      }
    }

    return count;
  }
}
