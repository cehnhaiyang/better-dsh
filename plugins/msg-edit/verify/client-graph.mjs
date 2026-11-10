import { readFileSync } from 'node:fs';
const BUNDLE = 'C:/Users/q1505/.dsh/plugins/msg-edit/client.js';
const ID = 'dsh-msg-edit';
const response = await fetch('http://127.0.0.1:3080/plugins/events', {
  headers: { accept: 'text/event-stream' },
  signal: AbortSignal.timeout(15000),
});
console.log('status', response.status);
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
if (graph === undefined) { console.log('no graph frame'); process.exitCode = 1; }
else {
  const entries = graph.graph?.entries ?? [];
  console.log('entries', entries.length);
  const mine = entries.filter((e) => String(e.id).includes('msg-edit'));
  for (const e of mine) console.log('MINE', JSON.stringify(e));
  if (mine.length === 0) { console.log('NOT IN GRAPH'); process.exitCode = 2; }
  else {
    const served = Buffer.from(await (await fetch('http://127.0.0.1:3080/' + mine[0].url)).arrayBuffer());
    const local = readFileSync(BUNDLE);
    console.log('served', served.length, 'local', local.length);
    console.log('prefix matches:', served.subarray(0, local.length).equals(local));
    console.log('tail:', JSON.stringify(served.subarray(local.length).toString('utf8')));
  }
}
