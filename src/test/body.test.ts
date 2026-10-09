import assert from 'node:assert/strict';
import { readBody } from '../server/body';

const post = (body: string) => new Request('http://x.test/', { method: 'POST', body });
const shape = { name: 'string', n: 'number', tags: 'strings', flag: 'boolean', cfg: 'object' } as const;

async function main() {
  assert.deepEqual(await readBody(post('{"name":"a","n":3,"tags":["x"],"flag":true,"cfg":{"k":1}}'), shape), {
    name: 'a', n: 3, tags: ['x'], flag: true, cfg: { k: 1 },
  });
  assert.deepEqual(await readBody(post('{}'), shape), {}, 'every field is optional');
  assert.deepEqual(await readBody(post('{"n":null}'), shape), { n: null }, 'null is "clear it", not an error');
  for (const bad of ['', '{', 'null', '[]', '"s"', '3', '{"name":["x"]}', '{"n":"3"}', '{"tags":["a",1]}', '{"cfg":[]}', '{"flag":1}', '{"n":1e999}']) {
    assert.equal(await readBody(post(bad), shape), null, `${bad || '(empty)'} must be refused`);
  }
  console.log('ok - request bodies are checked before a handler touches them');
}

void main();
