import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyNewsState, type NewsState } from "./types";

/** Small replaceable storage abstraction. No database: server-side cache file (or memory). Swap for KV/Postgres later. */
export interface NewsRepository {
  load(): Promise<NewsState>;
  save(s: NewsState): Promise<void>;
}

export class MemoryNewsRepository implements NewsRepository {
  constructor(private state: NewsState = emptyNewsState()) {}
  async load() { return this.state; }
  async save(s: NewsState) { this.state = s; }
}

export class FileNewsRepository implements NewsRepository {
  private file: string;
  constructor(dir = process.env.VERCEL ? path.join(os.tmpdir(), "fpl-intelligence") : path.join(process.cwd(), ".cache")) {
    this.file = path.join(dir, "news.json");
  }
  async load(): Promise<NewsState> {
    try {
      const s = JSON.parse(await fs.readFile(this.file, "utf8")) as NewsState;
      return s?.version === 1 && Array.isArray(s.items) ? s : emptyNewsState();
    } catch { return emptyNewsState(); }
  }
  async save(s: NewsState) {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(s));
    } catch { /* read-only filesystem: the in-memory copy still serves this instance */ }
  }
}
