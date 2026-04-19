import * as fs from 'fs';
import * as path from 'path';

const WATCHABLE_EXTENSIONS = new Set([
  '.java', '.ts', '.tsx', '.js', '.jsx', '.scala', '.sc', '.graphql', '.gql',
]);

export interface FileWatcherOptions {
  debounceMs?: number;
  onChange: (files: string[]) => void;
}

/**
 * Watches a directory for source file changes using fs.watch with recursive mode.
 * Debounces rapid changes into batched callbacks.
 */
export class FileWatcher {
  private onChange: (files: string[]) => void;
  private debounceMs: number;
  private pending: Set<string> = new Set();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchers: fs.FSWatcher[] = [];

  constructor(opts: FileWatcherOptions) {
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? 2000;
  }

  static isWatchableExtension(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return WATCHABLE_EXTENSIONS.has(ext);
  }

  enqueueChange(filePath: string): void {
    this.pending.add(filePath);
    this.scheduleDebouncedFlush();
  }

  watchDirectory(dir: string): void {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (!FileWatcher.isWatchableExtension(filename)) return;

        const fullPath = path.join(dir, filename);
        this.enqueueChange(fullPath);
      });

      this.watchers.push(watcher);
    } catch {
      // fs.watch may not support recursive on all platforms
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    this.pending.clear();
  }

  private scheduleDebouncedFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const files = [...this.pending];
    this.pending.clear();
    this.timer = null;
    this.onChange(files);
  }
}
