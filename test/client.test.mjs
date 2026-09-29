import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  MCServerConnect,
  MCServerError,
  pingServer,
  queryStatus,
  queryStatusWithPing,
} from '../dist/index.js';

// Independent wire helpers keep these tests focused on the public API and protocol.
function varInt(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    const byte = rest & 0x7f;
    rest >>>= 7;
    bytes.push(byte | (rest ? 0x80 : 0));
  } while (rest);
  return Buffer.from(bytes);
}

function readVarInt(bytes, offset = 0) {
  let value = 0;
  for (let size = 1; size <= 5; size++) {
    const byte = bytes[offset + size - 1];
    if (byte === undefined) return undefined;
    value |= (byte & 0x7f) << ((size - 1) * 7);
    if (!(byte & 0x80)) return { value, size };
  }
  throw new Error('Malformed client VarInt');
}

function packet(id, data = Buffer.alloc(0)) {
  const body = Buffer.concat([varInt(id), data]);
  return Buffer.concat([varInt(body.length), body]);
}

function statusPacket(status) {
  const json = Buffer.from(typeof status === 'string' ? status : JSON.stringify(status));
  return packet(0, Buffer.concat([varInt(json.length), json]));
}

function sampleStatus(online = 3) {
  return {
    version: { name: 'Paper 1.21.4', protocol: 769 },
    players: { online, max: 100 },
    description: '欢迎来到测试服务器',
  };
}

async function mockServer(t, { onStatus, onPing, protocolVersion = -1 } = {}) {
  const sockets = new Set();
  const timers = new Set();
  const failures = [];
  const requests = [];
  let port;
  const later = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setNoDelay(true);
    const request = { index: requests.length + 1, packets: [] };
    requests.push(request);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      try {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length) {
          const length = readVarInt(pending);
          if (!length || pending.length < length.size + length.value) return;
          const body = pending.subarray(length.size, length.size + length.value);
          pending = pending.subarray(length.size + length.value);
          const id = readVarInt(body);
          assert.ok(id, 'client packet has an ID');
          request.packets.push(id.value);
          if (request.packets.length === 1) {
            assert.equal(id.value, 0);
            let offset = id.size;
            const protocol = readVarInt(body, offset);
            assert.equal(protocol.value, protocolVersion);
            offset += protocol.size;
            const hostLength = readVarInt(body, offset);
            offset += hostLength.size;
            assert.equal(body.subarray(offset, offset + hostLength.value).toString(), '127.0.0.1');
            offset += hostLength.value;
            assert.equal(body.readUInt16BE(offset), port);
            offset += 2;
            assert.deepEqual([...body.subarray(offset)], [1], 'handshake enters status state');
          } else if (request.packets.length === 2) {
            assert.deepEqual([...body], [0], 'status request has no fields');
            if (onStatus) onStatus(socket, request, later);
            else socket.write(statusPacket(sampleStatus(request.index)));
          } else {
            assert.equal(request.packets.length, 3, 'one ping per connection');
            assert.equal(id.value, 1, 'ping uses packet 0x01');
            const payload = body.subarray(id.size);
            assert.equal(payload.length, 8, 'ping uses an eight-byte Long');
            if (onPing) onPing(socket, payload, request, later);
            else socket.write(packet(1, payload));
          }
        }
      } catch (error) {
        failures.push(error);
        socket.destroy();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, [], 'mock server observed valid client packets');
  });
  return { port, requests };
}

test('getStatus reassembles fragmented VarInts and UTF-8, parses MOTD, and strips the icon prefix', async (t) => {
  const status = sampleStatus();
  status.description = { text: '§a欢迎', extra: ['来到', { text: '\n服务器', extra: [{ text: '！' }] }] };
  status.players.sample = [{ name: 'Alex', id: '00000000-0000-0000-0000-000000000001' }];
  status.favicon = 'data:image/png;base64,aWNvbg==';
  const response = statusPacket(status);
  assert.ok(response[0] & 0x80, 'fixture uses a multi-byte length');
  const { port, requests } = await mockServer(t, {
    onStatus(socket, _request, later) {
      let offset = 0;
      const send = () => {
        if (socket.destroyed) return;
        const size = offset < 5 ? 1 : 11;
        socket.write(response.subarray(offset, offset + size));
        offset += size;
        if (offset < response.length) later(send, 1);
      };
      send();
    },
  });
  const result = await new MCServerConnect('127.0.0.1', port).getStatus();
  assert.deepEqual(result, {
    version: status.version,
    players: status.players,
    motd: '欢迎来到\n服务器！',
    icon: 'aWNvbg==',
  });
  assert.deepEqual(requests.map((request) => request.packets), [[0, 0]]);
});

test('each getter starts a fresh query and absent icons return undefined', async (t) => {
  const { port, requests } = await mockServer(t);
  const client = new MCServerConnect('127.0.0.1', String(port));
  assert.equal(client.host, '127.0.0.1');
  assert.equal(client.port, port);
  assert.equal(requests.length, 0, 'construction does not open a socket');
  assert.deepEqual(await client.getVersion(), sampleStatus().version);
  assert.equal(await client.getOnlinePlayerCount(), 2);
  assert.equal(await client.getOnlinePlayerCount(), 3);
  assert.equal(await client.getMaxPlayerCount(), 100);
  assert.equal(await client.getMOTD(), sampleStatus().description);
  assert.equal(await client.getIcon(), undefined);
  assert.equal((await client.getStatus()).players.online, 7);
  assert.equal(requests.length, 7);
  assert.ok(requests.every((request) => request.packets.length === 2));
});

test('getStatusWithPing measures only 0x01 Ping/Pong RTT and sends the selected protocol', async (t) => {
  const { port, requests } = await mockServer(t, {
    protocolVersion: 769,
    onStatus(socket, _request, later) {
      later(() => socket.write(statusPacket(sampleStatus())), 120);
    },
    onPing(socket, payload, _request, later) {
      later(() => socket.write(packet(1, payload)), 25);
    },
  });
  const start = performance.now();
  const result = await new MCServerConnect('127.0.0.1', String(port), { protocolVersion: 769 }).getStatusWithPing();
  const elapsed = performance.now() - start;
  assert.deepEqual(result.version, sampleStatus().version);
  assert.equal(result.motd, sampleStatus().description);
  assert.ok(Number.isFinite(result.latency));
  assert.ok(result.latency >= 15, `latency was ${result.latency}`);
  assert.ok(elapsed - result.latency >= 90, 'status response delay is excluded from ping latency');
  assert.deepEqual(requests[0].packets, [0, 0, 1]);
});

test('functional APIs and instance ping return fresh status and numeric millisecond latency', async (t) => {
  const { port, requests } = await mockServer(t);
  assert.equal((await queryStatus('127.0.0.1', port)).players.online, 1);
  const combined = await queryStatusWithPing('127.0.0.1', port);
  assert.equal(combined.players.online, 2);
  assert.ok(Number.isFinite(combined.latency) && combined.latency >= 0);
  for (const latency of [
    await pingServer('127.0.0.1', port),
    await new MCServerConnect('127.0.0.1', port).ping(),
  ]) {
    assert.ok(Number.isFinite(latency) && latency >= 0);
  }
  assert.deepEqual(requests.map((request) => request.packets), [[0, 0], [0, 0, 1], [0, 0, 1], [0, 0, 1]]);
});

for (const [label, data] of [['empty response', Buffer.alloc(0)], ['partial frame', Buffer.from([20, 0, 18, 123])]]) {
  test(`rejects an early disconnect with ${label}`, async (t) => {
    const { port } = await mockServer(t, { onStatus: (socket) => socket.end(data) });
    await assert.rejects(queryStatus('127.0.0.1', port), { code: 'CONNECTION_CLOSED' });
  });
}

test('timeout covers the whole request even while response bytes keep arriving', async (t) => {
  const { port } = await mockServer(t, {
    onStatus(socket, _request, later) {
      socket.write(varInt(4096));
      const trickle = () => {
        if (socket.destroyed) return;
        socket.write(Buffer.from([0]));
        later(trickle, 15);
      };
      trickle();
    },
  });
  const start = performance.now();
  await assert.rejects(queryStatus('127.0.0.1', port, { timeout: 100 }), (error) => {
    assert.ok(error instanceof MCServerError);
    assert.equal(error.code, 'TIMEOUT');
    return true;
  });
  assert.ok(performance.now() - start < 1000, 'trickled bytes must not reset the deadline');
});

const malformedResponses = [
  ['empty frame', Buffer.from([0])],
  ['invalid length VarInt', Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0])],
  ['unexpected packet ID', packet(2)],
  ['invalid JSON', statusPacket('{invalid}')],
  ['missing status fields', statusPacket({})],
  ['negative player count', statusPacket({ ...sampleStatus(), players: { online: -1, max: 10 } })],
  ['non-integer player count', statusPacket({ ...sampleStatus(), players: { online: 0.5, max: 10 } })],
  ['truncated JSON string', packet(0, Buffer.from([10, 123, 125]))],
  ['trailing response bytes', packet(0, Buffer.from([2, 123, 125, 0]))],
];

for (const [label, response] of malformedResponses) {
  test(`rejects ${label} as a protocol error`, async (t) => {
    const { port } = await mockServer(t, { onStatus: (socket) => socket.write(response) });
    await assert.rejects(queryStatus('127.0.0.1', port, { timeout: 500 }), { code: 'PROTOCOL_ERROR' });
  });
}

for (const mode of ['mismatched token', 'short payload', 'wrong packet ID']) {
  test(`rejects a pong with ${mode}`, async (t) => {
    const { port } = await mockServer(t, {
      onPing(socket, payload) {
        const reply = Buffer.from(payload);
        if (mode === 'mismatched token') reply[0] ^= 1;
        socket.write(packet(mode === 'wrong packet ID' ? 0 : 1, mode === 'short payload' ? reply.subarray(1) : reply));
      },
    });
    await assert.rejects(pingServer('127.0.0.1', port), { code: 'PROTOCOL_ERROR' });
  });
}

test('validates constructor arguments without opening sockets', async () => {
  assert.equal(new MCServerConnect('localhost').port, 25565);
  assert.equal(new MCServerConnect('localhost', '25565').port, 25565);
  for (const port of ['', '25565abc', ' 25565', '1.5', '0x63', 0, -1, 65536, NaN, Infinity, 1.5]) {
    assert.throws(() => new MCServerConnect('localhost', port), /port/i);
  }
  for (const host of ['', 'local host', 'localhost\0']) {
    assert.throws(() => new MCServerConnect(host), /host/i);
  }
  assert.throws(() => new MCServerConnect('localhost', 25565, { timeout: 0 }), /timeout/i);
  assert.throws(() => new MCServerConnect('localhost', 25565, { protocolVersion: 1.5 }), /protocolVersion/i);
  await assert.rejects(queryStatus('localhost', 'invalid'), /port/i);
});
