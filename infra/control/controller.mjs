import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkGate, receiptKey } from '../../scripts/check-release.mjs';
import { Azure } from './azure.mjs';

export async function operate(io, [operation, ring, commit, digest, runId]) {
  if (ring !== io.ring || !['staging', 'production'].includes(ring) || !/^[1-9]\d*$/.test(runId) ||
      !(io.purpose === 'monitor' ? operation === 'monitor' : io.purpose === 'deploy' && ['promote', 'rollback'].includes(operation)))
    throw new Error('Operation not permitted for this job');
  const request = { operation, ring, commit, digest };
  const key = operation === 'monitor' ? null : receiptKey(request);
  const now = () => new Date().toISOString();
  await io.locked(async current => {
    if (operation === 'monitor') {
      if (!['healthy', 'unhealthy'].includes(current.status)) throw new Error('No settled deployment to observe');
      try {
        const checks = await io.verify(current);
        await io.record({ ...current, status: 'healthy', criticalChecksPassed: true, checks, completedChecks: checks.length, observedAt: now() });
      } catch (error) {
        await io.record({ ...current, status: 'unhealthy', criticalChecksPassed: false, observedAt: now() });
        throw error;
      }
      return;
    }
    const admission = async () => {
      if (operation === 'promote' && await io.read(ring, 'freeze.json')) throw new Error('Ring promotions are frozen');
      if (key) checkGate(request, await io.read(operation === 'rollback' ? ring : 'staging', key));
    };
    await admission();
    if (BigInt(runId) < BigInt(current.runId ?? 0)) throw new Error('Superseded release run');
    const same = current.runId === runId && current.operation === operation && current.digest === digest && current.commit === commit;
    if (same && current.status === 'healthy') { await io.verify(current); return; }
    if (current.status === 'deploying' && !same) throw new Error('Reconcile the pending execution before another release');
    const previous = current.status === 'deploying' ? current.previous : current.status === 'healthy' ? current : null;
    const release = { ...request, profile: 'public-demo-v1', runId, deploymentId: same ? current.deploymentId : randomUUID() };
    await io.record({ ...release, status: 'deploying', previous });
    try {
      await io.deploy(digest);
      const checks = await io.verify(release);
      await admission();
      const timestamp = now();
      const healthy = { ...release, status: 'healthy', criticalChecksPassed: true, checks, completedChecks: checks.length,
        deployedAt: timestamp, observedAt: timestamp };
      await io.archive(receiptKey({ ...request, operation: 'rollback' }), healthy);
      await io.record(healthy);
    } catch (error) {
      // With no good predecessor, close external ingress. Never leave an untested version marked healthy.
      if (previous) {
        await io.deploy(previous.digest);
        await io.verify(previous);
        await io.record({ ...previous, deploymentId: randomUUID(), runId, deployedAt: now(), observedAt: now(), restoredAfter: digest });
      } else {
        await io.contain();
        await io.record({ ...release, status: 'failed', criticalChecksPassed: false });
      }
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io = new Azure(process.env);
  await operate(io, process.argv.slice(2));
  console.log(`Verified ${io.ring}: ${io.origin}/demo`);
}
