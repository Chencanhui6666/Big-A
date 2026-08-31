import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(projectRoot, 'public', 'data');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

const manifest = await readJson(join(dataRoot, 'manifest.json'));
if (!manifest?.files?.portfolio || !manifest?.files?.review) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), symbols: [], reason: 'no-complete-latest-batch' }, null, 2));
  process.exit(0);
}

const batchRoot = join(dataRoot, manifest.path);
const [portfolio, review] = await Promise.all([
  readJson(join(batchRoot, manifest.files.portfolio)),
  readJson(join(batchRoot, manifest.files.review)),
]);
const symbols = new Map();
const add = (code, source) => {
  if (!code) return;
  const normalized = String(code).split('.')[0];
  const previous = symbols.get(normalized) ?? new Set();
  previous.add(source); symbols.set(normalized, previous);
};

const model = portfolio?.accounts?.find((account) => account.accountId === 'model');
for (const position of model?.positions ?? []) add(position.code, 'open-position');
for (const order of model?.nextPlan?.orders ?? []) add(order.code, 'next-session-plan');
for (const signal of review?.dailySignalReview?.signals ?? []) {
  if (signal.status?.startsWith('PENDING') || signal.threeDayReturn == null) add(signal.code, 'signal-settlement');
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  latestSnapshotId: manifest.snapshotId,
  symbols: [...symbols].sort(([a], [b]) => a.localeCompare(b)).map(([code, sources]) => ({ code, sources: [...sources].sort() })),
  instructions: 'Fetch exact Longbridge quote records for every code, preserve provider timestamps, and place them in provider-data/longbridge-latest.json as carryQuotes before running pipeline:real.',
}, null, 2));
