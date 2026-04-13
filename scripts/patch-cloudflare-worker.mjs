import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workerPath = resolve('.svelte-kit/cloudflare/_worker.js');
const scheduledImport =
	'import { handleScheduledInventoryAlert } from "../src/lib/server/worker-scheduled.ts";\n';

const workerSource = await readFile(workerPath, 'utf8');

if (workerSource.includes('handleScheduledInventoryAlert')) {
	process.exit(0);
}

const withImport = `${scheduledImport}${workerSource}`;
const patched = withImport.replace(
	'var worker_default = {',
	`var worker_default = {
  async scheduled(controller, env2, ctx) {
    return handleScheduledInventoryAlert(controller, env2, ctx);
  },`
);

if (patched === withImport) {
	throw new Error('Failed to patch Cloudflare worker with scheduled handler.');
}

await writeFile(workerPath, patched);
