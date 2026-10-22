import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [dist, storage, itemId, owner, directory] = process.argv.slice(2);
const { openDatabase } = await import(pathToFileURL(path.join(dist, 'storage/db.js')));
const { MergeQueue } = await import(pathToFileURL(path.join(dist, 'workspaces/merge-queue.js')));
const db = openDatabase(storage);
try {
  const queue = new MergeQueue(db, { event() {} }, owner);
  writeFileSync(path.join(directory, `${owner}-started`), String(process.pid));
  const result = await queue.run(itemId, {
    committer: { name: 'Process acceptance', email: 'fixture@example.test' },
    integrated(item) {
      appendFileSync(path.join(directory, 'integrations.jsonl'), JSON.stringify({ owner, id: item.id }) + '\n');
      if (owner === 'first') {
        writeFileSync(path.join(directory, 'first-held'), item.id);
        const limit = Date.now() + 15000;
        while (!existsSync(path.join(directory, 'release-first'))) {
          if (Date.now() > limit) throw new Error('test did not release integration owner');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    },
  });
  writeFileSync(path.join(directory, `${owner}-result.json`), JSON.stringify(result));
} finally { db.close(); }
