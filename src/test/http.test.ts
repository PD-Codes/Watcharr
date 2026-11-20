import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { apiFetch, joinUrl } from '../server/adapters/http';
import { isStrained } from '../server/strain';

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
  assert.equal(isStrained(`http://127.0.0.1:${port}/`), true, 'a light request timing out pauses the host');

  // A whole-library listing that runs long is big, not overloaded: it fails alone, no pause.
  const slow = createServer(() => {});
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = (slow.address() as { port: number }).port;
  await assert.rejects(() => apiFetch(`http://127.0.0.1:${slowPort}/library/sections/1/all`, { bulk: true, timeoutMs: 200 }));
  assert.equal(isStrained(`http://127.0.0.1:${slowPort}/`), false, 'a bulk timeout does not pause the host');
  slow.close();
  console.log('ok - a slow bulk listing does not count as an overloaded server');

  const responsive = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ServerName: 'Stub' }));
  });
  await new Promise<void>((resolve) => responsive.listen(0, '127.0.0.1', resolve));
  const okPort = (responsive.address() as { port: number }).port;

  const body = await apiFetch<{ ServerName: string }>(`http://127.0.0.1:${okPort}/System/Info`);
  assert.equal(body.ServerName, 'Stub', 'a normal response still comes through untouched');
  console.log('ok - the timeout does not disturb a healthy request');

  // The error text lands in the log and on the sync status; the query carries X-Plex-Token
  // or TMDB's api_key, so only origin and path may appear in it.
  const failing = createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no such item');
  });
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const failPort = (failing.address() as { port: number }).port;
  const error = await apiFetch(`http://127.0.0.1:${failPort}/library/metadata/1?X-Plex-Token=secret-token&api_key=tmdb-key`).then(
    () => null,
    (e: Error) => e,
  );
  assert.ok(error, 'a 404 throws');
  assert.equal(error.message, `GET http://127.0.0.1:${failPort}/library/metadata/1 failed: 404 no such item`);
  assert.ok(!/secret-token|tmdb-key|\?/.test(error.message), 'no query in the message');
  assert.equal((error as Error & { status?: number }).status, 404, 'the status is still carried');
  failing.close();
  console.log('ok - error messages leave the query (and its tokens) out');

  assert.equal(joinUrl('http://h:8096/', '/Items'), 'http://h:8096/Items', 'no double slash');
  console.log('ok - joinUrl');

  silent.close();
  responsive.close();
}

void main();
