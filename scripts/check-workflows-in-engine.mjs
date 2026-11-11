/** Real n8n/node execution with an isolated, simulated API. No production credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'docker.n8n.io/n8nio/n8n:2.45.4@sha256:80e23ced901f0e22597d4f3464e3aaf9d835372262ea6f08ef760d8ca35df25c';
const reportDirectory = process.argv[2];
if (!reportDirectory) throw new Error('Pass a report directory outside the source tree. Run pnpm build first.');
const report = path.resolve(reportDirectory);
await mkdir(report, { recursive: true });
const temporary = await mkdtemp(path.join(report, '.ngram-n8n-engine-'));
const network = `ngram-engine-${process.pid}`;
const server = `${network}-api`;
const volume = `${network}-data`;
const runtime = path.join(temporary, 'runtime');
const fixtures = path.join(temporary, 'fixtures');
await mkdir(fixtures);
const packageDirectory = path.join(runtime, 'nodes/node_modules/n8n-nodes-ngram');
await mkdir(packageDirectory, { recursive: true });
for (const file of ['package.json', 'dist', 'icons']) await cp(path.join(root, file), path.join(packageDirectory, file), { recursive: true });
await writeFile(path.join(runtime, 'nodes/package.json'), JSON.stringify({ private: true, dependencies: { 'n8n-nodes-ngram': '*' } }));
const run = (args, allowFailure = false, timeout = 90_000) => {
  try { return { code: 0, text: execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!allowFailure) throw new Error(`Docker command failed: ${args.slice(0, 3).join(' ')}\n${text.slice(-6000)}`);
    return { code: error.status ?? 1, text };
  }
};
const cli = (args, allowFailure = false) => run(['run', '--rm', '--network', network,
  '-e', 'N8N_USER_FOLDER=/home/node', '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
  '-e', 'NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules',
  '-v', `${volume}:/home/node/.n8n`, '-v', `${packageDirectory}:/home/node/.n8n/nodes/node_modules/n8n-nodes-ngram:ro`, '-v', `${path.join(runtime, 'nodes/package.json')}:/home/node/.n8n/nodes/package.json:ro`, '-v', `${fixtures}:/fixtures:ro`, '-v', `${path.join(root, 'templates')}:/starters:ro`, image, ...args], allowFailure);
const save = (name, data) => writeFile(path.join(fixtures, name), JSON.stringify(data, null, 2));
const apiSource = `import http from 'node:http';
const requests=[]; const keys=new Set(); let creations=0;
http.createServer(async (req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 res.setHeader('content-type','application/json');
 if(req.url==='/requests'){res.end(JSON.stringify({requests,creations}));return;}
 const [scenario,...parts]=req.url.slice(1).split('/');const route='/'+parts.join('/');
 const key=req.headers['idempotency-key']??null;
 requests.push({scenario,method:req.method,route,body,idempotencyKey:key});
 if(req.headers.authorization!=='Bearer internal-test-only'){res.writeHead(401).end(JSON.stringify({error:{message:'Missing test credential'}}));return;}
 if(scenario==='rejected'){res.writeHead(422).end(JSON.stringify({error:{message:'Invalid duration',details:{issues:[{path:'duration',message:'Choose a positive duration'}]}}}));return;}
 if(req.method==='POST'&&['/api/v1/videos','/api/v1/videos:fromText','/api/v1/videos:fromUrl'].includes(route)){
  if(!key||!keys.has(key)){creations++;if(key)keys.add(key);}
  res.writeHead(202).end(JSON.stringify({data:{id:'vid_internal_test',status:'processing'}}));return;
 }
 if(req.method==='GET'&&route==='/api/v1/videos/vid_internal_test'){
  const data={id:'vid_internal_test',status:scenario==='success'?'completed':scenario,progress:scenario==='processing'?42:100,created_at:'2026-10-27T00:00:00Z'};
  if(scenario==='success')data.result={url:'https://example.invalid/test.mp4',duration_ms:30000};
  if(scenario==='failed'){data.error_code='render_failed';data.error='Simulated render failure';}
  res.end(JSON.stringify({data}));return;
 }
 res.writeHead(404).end(JSON.stringify({error:{message:'Unexpected fixture request'}}));
}).listen(8080,'0.0.0.0');`;
await writeFile(path.join(fixtures, 'api.mjs'), apiSource);
const credential = (scenario) => ({ ngramApi: { id: `internal-${scenario}`, name: `internal-${scenario}` } });
const edge = (node) => ({ node, type: 'main', index: 0 });
const start = { id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const cases = [];
for (const scenario of ['success', 'processing', 'failed', 'rejected']) {
 for (const operation of scenario === 'success' ? ['create', 'createFromText', 'createFromUrl'] : ['createFromText']) {
  const id = `${scenario}-${operation}`;
  const workflow = { id, name: id, active: false, settings: { executionOrder: 'v1' }, nodes: [start,
   { id: 'create', name: 'Create video', type: 'n8n-nodes-ngram.ngram', typeVersion: 1, position: [240, 0], credentials: credential(scenario), parameters: {
    resource: 'video', operation, prompt: 'Explain these public release notes.', website_url: 'https://example.com/releases', style_id: 'editorial', aspect_ratio: '16:9', duration: 30, idempotency_key: id,
   } },
   { id: 'status', name: 'Get the same video', type: 'n8n-nodes-ngram.ngram', typeVersion: 1, position: [480, 0], credentials: credential(scenario), parameters: { resource: 'video', operation: 'getStatus', videoId: '={{ $json.id }}' } },
  ], connections: { Start: { main: [[edge('Create video')]] }, 'Create video': { main: [[edge('Get the same video')]] } } };
  await save(`${id}.json`, workflow); cases.push({ id, scenario });
 }
}
for (const merged of [true, false]) {
 const workflow = JSON.parse(await readFile(path.join(root, 'templates/changelog-video-from-github-merged-pr.json'), 'utf8'));
 workflow.id = merged ? 'github-merged' : 'github-unmerged';
 const event = { action: 'closed', repository: { id: 1001 }, pull_request: { merged, number: 42, merge_commit_sha: 'a'.repeat(40), title: 'Faster search', body: 'Find projects by title.', html_url: 'https://example.com/pr/42', user: { login: 'example' } } };
 // Replace only the external GitHub trigger. Execute the published predicate and create mapping unchanged.
 workflow.nodes[0] = { id: 'source', name: 'GitHub Pull Request Event', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0], parameters: { jsCode: `return [{ json: ${JSON.stringify(event)} }];` } };
 workflow.nodes.unshift(start);
 workflow.connections.Start = { main: [[edge('GitHub Pull Request Event')]] };
 workflow.nodes.find((node) => node.name === 'Create ngram Video').credentials = credential('success');
 await save(`${workflow.id}.json`, workflow); cases.push({ id: workflow.id, merged });
}
await save('credentials.json', ['success', 'processing', 'failed', 'rejected'].map((scenario) => ({ id: `internal-${scenario}`, name: `internal-${scenario}`, type: 'ngramApi', data: { apiKey: 'internal-test-only', baseUrl: `http://fixture-api:8080/${scenario}` } })));
const checks = [];
let networkCreated = false;
let volumeCreated = false;
let serverCreated = false;
try {
 if (run(['image', 'inspect', image], true).code !== 0) run(['pull', image], false, 300_000);
 run(['volume', 'create', volume]); volumeCreated = true;
 run(['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'chown', '-v', `${volume}:/data`, image, '1000:1000', '/data']);
 run(['network', 'create', '--internal', network]); networkCreated = true;
 run(['run', '-d', '--name', server, '--network', network, '--network-alias', 'fixture-api', '--entrypoint', 'node', '-v', `${fixtures}:/fixtures:ro`, image, '/fixtures/api.mjs']); serverCreated = true;
 await writeFile(path.join(report, 'credentials-import.log'), cli(['import:credentials', '--input=/fixtures/credentials.json']).text);
 const imported = cli(['import:workflow', '--separate', '--input=/starters']);
 await writeFile(path.join(report, 'starter-import.log'), imported.text);
 assert.match(imported.text, /Successfully imported 8 workflows/);
 cli(['export:workflow', '--all', '--output=/home/node/.n8n/imported.json']);
 const importedWorkflows = JSON.parse(run(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', '-v', `${volume}:/data:ro`, image, '/data/imported.json']).text);
 assert.equal(importedWorkflows.length, 8);
 assert.ok(importedWorkflows.every((workflow) => workflow.active === false));
 checks.push('Eight starters import inactive');
 for (const test of [...cases, { id: 'github-merged', merged: true, replay: true }]) {
  if (!test.replay) cli(['import:workflow', `--input=/fixtures/${test.id}.json`]);
  const result = cli(['execute', `--id=${test.id}`, '--rawOutput'], true);
  await writeFile(path.join(report, `${test.id}${test.replay ? '-replay' : ''}.log`), result.text);
  const begin = result.text.indexOf('{\n  "data"');
  assert.ok(begin >= 0, result.text);
  const execution = JSON.parse(result.text.slice(begin, result.text.indexOf('\n}', begin) + 2));
  const nodes = execution.data.resultData.runData;
  if (test.scenario === 'rejected') {
   assert.notEqual(result.code, 0); assert.equal(execution.status, 'error');
   assert.ok(!nodes['Get the same video']); assert.match(result.text, /Choose a positive duration/);
  } else {
   assert.equal(result.code, 0, result.text); assert.equal(execution.status, 'success');
   if (test.merged !== undefined) assert.equal(Boolean(nodes['Create ngram Video']), test.merged);
   else {
    const output = nodes['Get the same video'][0].data.main[0][0].json;
    assert.equal(output.id, 'vid_internal_test');
    assert.equal(output.status, test.scenario === 'success' ? 'completed' : test.scenario);
    if (test.scenario === 'success') assert.equal(output.video_url, 'https://example.invalid/test.mp4');
    if (test.scenario === 'processing') { assert.equal(output.progress, 42); assert.equal(output.video_url, null); }
    if (test.scenario === 'failed') { assert.equal(output.error_code, 'render_failed'); assert.equal(output.video_url, null); }
   }
  }
  checks.push(`${test.id}${test.replay ? '-replay' : ''}`); console.log(`Passed: ${checks.at(-1)}`);
 }
 const api = JSON.parse(run(['exec', server, 'node', '-e', 'fetch("http://127.0.0.1:8080/requests").then(r=>r.text()).then(console.log)']).text);
 const creations = api.requests.filter((request) => request.method === 'POST');
 assert.equal(creations.length, 8); // Six action cases plus the merged event twice; unmerged produces none.
 assert.equal(api.creations, 6); // Rejected input and the replay start no new simulated job.
 for (const request of creations) {
  assert.ok(request.idempotencyKey); assert.equal(request.body.duration, 30); assert.equal(request.body.aspect_ratio, '16:9');
 }
 const mergedRequests = creations.filter((request) => request.idempotencyKey.startsWith('github:'));
 assert.equal(mergedRequests.length, 2); assert.equal(mergedRequests[0].idempotencyKey, mergedRequests[1].idempotencyKey);
 await writeFile(path.join(report, 'requests.json'), JSON.stringify(api, null, 2));
 await writeFile(path.join(report, 'receipt.json'), JSON.stringify({ image, checks, boundary: 'Real n8n and candidate node; simulated API and GitHub event. No live generation or external delivery.', liveGenerationVerified: false }, null, 2));
 console.log(`Internal engine checks passed. Evidence: ${report}`);
} finally {
 if (serverCreated) run(['rm', '-f', server], true);
 if (networkCreated) run(['network', 'rm', network], true);
 if (volumeCreated) run(['volume', 'rm', volume], true);
 await rm(temporary, { recursive: true, force: true });
}
