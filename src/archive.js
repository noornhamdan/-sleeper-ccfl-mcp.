import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const kinds = new Set(['snapshots', 'evidence', 'observations', 'decisions']);
export class Archive {
  constructor(root = process.env.CCFL_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url))) { this.root = resolve(root); }
  async save(kind, data) {
    if (!kinds.has(kind)) throw new Error('Unknown archive kind');
    const directory = join(this.root, kind);
    await mkdir(directory, { recursive: true });
    const id = `${Date.now()}-${randomUUID()}`;
    const record = { schema_version: 1, id, saved_at: new Date().toISOString(), data };
    // Exclusive creation prevents concurrent sessions from overwriting records.
    const temporary = join(directory, `${id}.tmp`);
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, `${id}.json`));
    return record;
  }
  async list(kind, { league_id, season, week, limit = 20 } = {}) {
    if (!kinds.has(kind)) throw new Error('Unknown archive kind');
    const directory = join(this.root, kind);
    let files;
    try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of files.filter(f => /^\d+-[a-f0-9-]+\.json$/.test(f)).sort().reverse()) {
      const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const d = record.data;
      if (league_id && (d.league_id || d.league?.league_id) !== league_id) continue;
      if (season && String(d.season || d.league?.season) !== String(season)) continue;
      if (week && d.week !== week) continue;
      records.push(record);
      if (records.length >= limit) break;
    }
    return records;
  }
}
export const archive = new Archive();
