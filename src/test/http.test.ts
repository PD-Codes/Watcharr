import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { apiFetch, joinUrl } from '../server/adapters/http';

// The whole app renders behind a media server request: the activity sync sits in the app
// layout. A server that accepts the connection and then says nothing is the case that hurt
// — it never rejects, so the catch() around the sync never runs and every page hangs.
async function main() {
  const silent = createServer(() => {
    // Deliberately no response, ever.
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const port = (silent.address() as { port: number }).port;

  const started = Date.now();
  await assert.rejects(
    () => apiFetch(`http://127.0.0.1:${port}/System/Info`, { timeoutMs: 200 }),
    'a silent media server has to fail instead of hanging',
  );
  assert.ok(Date.now() - started < 5_000, 'it must fail at the timeout, not eventually');
  console.log('ok - a silent server times out instead of hanging the render');

  const responsive = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ServerName: 'Stub' }));
  });
  await new Promise<void>((resolve) => responsive.listen(0, '127.0.0.1', resolve));
  const okPort = (responsive.address() as { port: number }).port;

  const body = await apiFetch<{ ServerName: string }>(`http://127.0.0.1:${okPort}/System/Info`);
  assert.equal(body.ServerName, 'Stub', 'a normal response still comes through untouched');
  console.log('ok - the timeout does not disturb a healthy request');

  assert.equal(joinUrl('http://h:8096/', '/Items'), 'http://h:8096/Items', 'no double slash');
  console.log('ok - joinUrl');

  silent.close();
  responsive.close();
}

void main();
