import assert from 'node:assert/strict';
import { isPrivateAddress, normalise } from '../server/net';

const local = (address: string) =>
  assert.ok(isPrivateAddress(address), `${address} should count as local`);
const remote = (address: string) =>
  assert.ok(!isPrivateAddress(address), `${address} should count as remote`);

local('192.168.1.5');
local('10.0.0.1');
local('172.16.0.1');
local('172.31.255.254');
local('127.0.0.1');
local('169.254.10.1'); // link-local
local('100.100.0.1'); // carrier-grade NAT, still not the public internet
console.log('ok - private IPv4 ranges are local');

remote('8.8.8.8');
remote('172.15.0.1'); // just below the private block
remote('172.32.0.1'); // just above it
remote('100.63.255.255');
remote('100.128.0.1');
remote('93.184.216.34');
console.log('ok - the edges of the private blocks are remote');

local('::1');
local('fd00::1'); // unique local
local('fe80::1ff:fe23:4567:890a'); // link-local
remote('2606:4700:4700::1111');
console.log('ok - IPv6 loopback, ULA and link-local are local');

// Media servers report addresses in several shapes.
assert.equal(normalise('192.168.1.5:47204'), '192.168.1.5', 'a port is stripped');
assert.equal(normalise('[::1]:8096'), '::1', 'brackets and port are stripped');
assert.equal(normalise('::ffff:192.168.1.5'), '192.168.1.5', 'IPv4-mapped addresses unwrap');
assert.equal(normalise('fe80::1%eth0'), 'fe80::1', 'the zone index is dropped');
local('::ffff:10.0.0.7');
local('192.168.1.5:47204');
remote('[2606:4700::1111]:32400');
console.log('ok - addresses are normalised before classification');

// Nothing usable must not be claimed as local — that would hide a real remote stream.
remote('');
remote('   ');
remote('not-an-address');
console.log('ok - unparsable addresses are not treated as local');
