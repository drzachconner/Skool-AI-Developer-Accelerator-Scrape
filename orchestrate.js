/**
 * Pipeline Orchestrator - AI Developer Accelerator
 *
 * Phase 1 (sequential): node downloader.js
 * Phase 2 (parallel):   node resource-downloader-v2.js
 * Phase 3 (sequential): node post-process.js
 *
 * Run: node orchestrate.js
 */

const { spawn } = require('child_process');
const path = require('path');

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const label = `[${path.basename(script)}]`;
    console.log(`\n${label} Starting...`);

    const child = spawn('node', [script, ...args], {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`${label} Exited with code ${code}`);
        reject(new Error(`${script} failed with code ${code}`));
      } else {
        console.log(`${label} Completed successfully`);
        resolve();
      }
    });

    child.on('error', (err) => {
      console.error(`${label} Failed to start: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  const startTime = Date.now();
  console.log('=== Full Pipeline Orchestrator ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // Phase 1: Scrape classroom + posts
  console.log('\n========== PHASE 1: Scrape Classroom + Posts ==========');
  await run(path.join(__dirname, 'downloader.js'));

  // Phase 2: Resource downloads
  console.log('\n========== PHASE 2: Resource Downloads ==========');
  const resourceResult = await Promise.allSettled([
    run(path.join(__dirname, 'resource-downloader-v2.js')),
  ]);

  if (resourceResult[0].status === 'rejected') {
    console.error(`Resource download failed: ${resourceResult[0].reason.message}`);
  }

  // Phase 3: Post-processing
  console.log('\n========== PHASE 3: Post-Processing ==========');
  await run(path.join(__dirname, 'post-process.js'));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Pipeline Complete (${elapsed} min) ===`);
}

main().catch((e) => {
  console.error(`\nPipeline error: ${e.message}`);
  process.exit(1);
});
