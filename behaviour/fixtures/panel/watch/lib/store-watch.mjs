// Tells the server when the config store changes on disk (another process saved it), so the dev server can say so.
import fs from 'node:fs';
import path from 'node:path';

export function watchStore(file, onChange) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(dir, (event, name) => {
    if (name === path.basename(file)) onChange();
  });
  return () => watcher.close();
}
