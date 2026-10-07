#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { archive } from './archive.js';
import { snapshot } from './sleeper.js';
import { validateBundle, scoringHash, analyzeLineup } from './analysis.js';
import { evidenceFor } from './feed.js';

const [command, filename] = process.argv.slice(2);
try {
  if (command === 'capture') {
    const data = await snapshot(filename ? Number(filename) : undefined);
    console.log(JSON.stringify({ fetched_at: data.fetched_at, history: data.history, scoring_hash: scoringHash(data.league.scoring_settings) }));
  } else if (command === 'import') {
    const bundle = validateBundle(JSON.parse(await readFile(filename, 'utf8')));
    const live = await snapshot(bundle.week);
    // Validate scoring, source age, league identity and stats before storing input.
    analyzeLineup(live, bundle);
    const saved = await archive.save('evidence', bundle);
    console.log(JSON.stringify({ evidence_id: saved.id, projections: bundle.projections.length }));
  } else if (command === 'optimize') {
    const live = await snapshot();
    const entry = await evidenceFor(live);
    const analysis = analyzeLineup(live, entry.data);
    if (analysis.status === 'ready') analysis.decision_id = (await archive.save('decisions', analysis)).id;
    console.log(JSON.stringify(analysis, null, 2));
  } else if (command === 'export') {
    const records = {};
    for (const kind of ['snapshots', 'evidence', 'observations', 'decisions']) records[kind] = await archive.list(kind, { limit: Number.MAX_SAFE_INTEGER });
    await writeFile(filename, JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), records }, null, 2), { mode: 0o600 });
    console.log('Archive exported');
  } else {
    throw new Error('Usage: node src/cli.js capture [week] | import evidence.json | optimize | export backup.json');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
