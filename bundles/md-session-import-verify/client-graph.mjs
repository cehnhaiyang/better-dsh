/**
 * Read the composed Client module graph from the running Harness and report
 * whether this bundle's browser half is in it, then fetch the advertised URL and
 * check the served bytes are the local file plus the harness's own source-map
 * reference. `/plugins/events` writes the graph on connect, so this answers the
 * question without browser control.
 */
import { readFileSync } from 'node:fs';

const BUNDLE = 'C:/Users/q1505/.dsh/bundles/md-session-import/client.js';

const response = await fetch('http://127.0.0.1:3080/plugins/events', {
  headers: { accept: 'text/event-stream' },
  signal: AbortSignal.timeout(15000),
});
console.log('status', response.status, response.headers.get('content-type'));
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let graph;
while (graph === undefined) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const match = /^data: (.*)$/mu.exec(buffer);
  if (match !== null) graph = JSON.parse(match[1]);
}
await reader.cancel().catch(() => {});
if (graph === undefined) {
  console.log('no graph frame received');
  process.exitCode = 1;
} else {
  const entries = graph.graph?.entries ?? [];
  console.log(`graph type=${graph.type} entries=${entries.length}`);
  const mine = entries.filter((entry) => String(entry.id).includes('md-session-import'));
  for (const entry of mine) console.log('MINE', JSON.stringify(entry));
  if (mine.length === 0) {
    console.log('NOT IN GRAPH');
    process.exitCode = 2;
  } else if (mine.length !== 1) {
    console.log(`expected exactly one entry, found ${mine.length}`);
    process.exitCode = 3;
  } else {
    const served = Buffer.from(await (await fetch(`http://127.0.0.1:3080/${mine[0].url}`)).arrayBuffer());
    const local = readFileSync(BUNDLE);
    const prefixMatches = served.subarray(0, local.length).equals(local);
    const tail = served.subarray(local.length).toString('utf8');
    console.log(`served ${served.length} bytes, local ${local.length} bytes`);
    console.log('served payload equals the local bundle:', prefixMatches);
    console.log('appended by the harness:', JSON.stringify(tail));
    const ok = prefixMatches && /^;\n\/\/# sourceMappingURL=\?\?dsh-md-session-import\/client\.js\.map&rev=[0-9a-f]+\n$/u.test(tail);
    if (!ok) {
      console.log('SERVED BUNDLE MISMATCH');
      process.exitCode = 4;
    }
  }
}

