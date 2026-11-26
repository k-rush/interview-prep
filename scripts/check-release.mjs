import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The thresholds belong to the ring that produced the evidence, not its successor.
const rings = new Map([
  ['staging',    { previous: null, minutes: 30, samples: 5 }],
  ['production', { previous: 'staging' }],
]);

export function receiptKey({ operation, ring, commit, digest }) {
  if (!rings.has(ring) || !['promote', 'rollback'].includes(operation) ||
      !/^[0-9a-f]{40}$/.test(commit) || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Invalid release coordinates');
  }
  if (operation === 'rollback') return `history/${ring}/${commit}/${digest.slice(7)}.json`;
  const previous = rings.get(ring).previous;
  return previous && `rings/${previous}/current.json`;
}

export function checkGate(request, receipt, now = Date.now()) {
  if (!receiptKey(request)) return; // Staging still requires signed provenance.
  const rollback = request.operation === 'rollback';
  const source = rollback ? request.ring : rings.get(request.ring).previous;
  if (receipt?.ring !== source || receipt.commit !== request.commit || receipt.digest !== request.digest ||
      receipt.status !== 'healthy' || receipt.criticalChecksPassed !== true || !receipt.deploymentId) {
    throw new Error('No matching healthy receipt for this release and ring');
  }
  if (rollback) return; // The controller must still check retention and compatibility with the current schema.
  const start = Date.parse(receipt.deployedAt), end = Date.parse(receipt.observedAt);
  const { minutes, samples } = rings.get(source);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end > now || now - end > 2 * 3600_000 ||
      end - start < minutes * 60_000 || !Number.isSafeInteger(receipt.completedChecks) ||
      receipt.completedChecks < samples) {
    throw new Error('Missing, stale, or insufficient observation window; hold promotion');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, ring, commit, digest] = process.argv.slice(2);
  const request = { operation, ring, commit, digest };
  const key = receiptKey(request);
  if (key) {
    const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
    try {
      const file = join(dir, 'receipt.json');
      execFileSync('az', ['storage', 'blob', 'download', '--auth-mode', 'login',
        '--account-name', process.env.RELEASE_STORAGE_ACCOUNT, '--container-name', 'releases',
        '--name', key, '--file', file, '--only-show-errors', '-o', 'none'], { stdio: 'inherit' });
      checkGate(request, JSON.parse(readFileSync(file, 'utf8')));
    } finally {
      rmSync(join(dir, 'receipt.json'), { force: true });
      rmdirSync(dir);
    }
  }
}
