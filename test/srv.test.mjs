import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { createServer, Socket } from 'node:net';
import test from 'node:test';
import {
  MCServerConnect,
  MCServerError,
  pingServer,
  queryStatus,
  queryStatusWithPing,
} from '../dist/index.js';

const status = {
  version: { name: 'SRV 测试服', protocol: 769 },
  players: { online: 3, max: 20 },
  description: '欢迎来到测试服务器',
};
const expectedStatus = {
  version: status.version,
  players: status.players,
  motd: status.description,
};

// 独立编码测试报文，避免服务端与客户端共用实现而掩盖协议错误。
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
  throw new Error('测试服务器收到非法 VarInt');
}

function packet(id, data) {
  const body = Buffer.concat([varInt(id), data]);
  return Buffer.concat([varInt(body.length), body]);
}

function readHandshake(body) {
  const id = readVarInt(body);
  assert.equal(id.value, 0);
  const protocol = readVarInt(body, id.size);
  const lengthOffset = id.size + protocol.size;
  const hostLength = readVarInt(body, lengthOffset);
  const hostOffset = lengthOffset + hostLength.size;
  const portOffset = hostOffset + hostLength.value;
  assert.deepEqual([...body.subarray(portOffset + 2)], [1]);
  return {
    host: body.subarray(hostOffset, portOffset).toString(),
    port: body.readUInt16BE(portOffset),
  };
}

async function mockServer(t, { statusDelay = 0 } = {}) {
  const sockets = new Set();
  const timers = new Set();
  const requests = [];
  const failures = [];
  const json = Buffer.from(JSON.stringify(status));
  const response = packet(0, Buffer.concat([varInt(json.length), json]));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const request = { handshake: undefined, packets: [] };
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
          request.packets.push(id.value);
          if (request.packets.length === 1) {
            request.handshake = readHandshake(body);
          } else if (request.packets.length === 2) {
            assert.deepEqual([...body], [0]);
            if (statusDelay === 0) socket.write(response);
            else {
              const timer = setTimeout(() => {
                timers.delete(timer);
                if (!socket.destroyed) socket.write(response);
              }, statusDelay);
              timers.add(timer);
            }
          } else {
            assert.equal(request.packets.length, 3);
            assert.equal(id.value, 1);
            const token = body.subarray(id.size);
            assert.equal(token.length, 8);
            socket.write(packet(1, token));
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
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, [], '客户端应发送完整且有效的状态查询报文');
  });
  return { port: server.address().port, requests };
}

function srvRecord(port, overrides = {}) {
  return { name: '127.0.0.1', port, priority: 0, weight: 1, ...overrides };
}

// 将任意测试域名和默认端口转接到本地动态端口，同时记录客户端原本选择的地址。
function redirectConnections(t, port) {
  const originalConnect = Socket.prototype.connect;
  const connections = [];
  t.mock.method(Socket.prototype, 'connect', function (options) {
    connections.push({ host: options.host, port: options.port });
    return originalConnect.call(this, { ...options, host: '127.0.0.1', port });
  });
  return connections;
}

test('SRV 查询与直接连接得到相同状态，并为每次请求重新解析', async (t) => {
  const { port, requests } = await mockServer(t);
  const dns = t.mock.method(Resolver.prototype, 'resolveSrv', async () => [srvRecord(port)]);
  const connections = redirectConnections(t, port);
  const client = new MCServerConnect('play.example.test');
  assert.equal(client.host, 'play.example.test');
  assert.equal(client.port, 25565);
  assert.equal(dns.mock.callCount(), 0, '构造时不进行 DNS 查询');
  assert.equal(connections.length, 0, '构造时不建立 TCP 连接');

  const direct = await new MCServerConnect('127.0.0.1', port).getStatus();
  assert.deepEqual(await client.getStatus(), direct);
  assert.deepEqual(await client.getStatus(), direct);
  assert.equal(dns.mock.callCount(), 2);
  assert.deepEqual(dns.mock.calls.map((call) => call.arguments), [
    ['_minecraft._tcp.play.example.test'],
    ['_minecraft._tcp.play.example.test'],
  ]);
  assert.deepEqual(connections, Array(3).fill({ host: '127.0.0.1', port }));
  assert.deepEqual(requests.map((request) => request.handshake), [
    { host: '127.0.0.1', port },
    { host: 'play.example.test', port: 25565 },
    { host: 'play.example.test', port: 25565 },
  ]);
});

test('函数式 API 省略端口或传入 undefined 时均支持 SRV 与 Ping/Pong', async (t) => {
  const { port, requests } = await mockServer(t);
  const dns = t.mock.method(Resolver.prototype, 'resolveSrv', async () => [srvRecord(port)]);
  assert.deepEqual(await queryStatus('play.example.test'), expectedStatus);
  assert.deepEqual(await queryStatus('play.example.test', undefined, { timeout: 1000 }), expectedStatus);
  const result = await queryStatusWithPing('play.example.test');
  assert.deepEqual({ ...result, latency: undefined }, { ...expectedStatus, latency: undefined });
  assert.ok(Number.isFinite(result.latency) && result.latency >= 0);
  assert.ok(Number.isFinite(await pingServer('play.example.test', undefined, { timeout: 1000 })));
  assert.equal(dns.mock.callCount(), 4);
  assert.deepEqual(requests.map((request) => request.packets), [[0, 0], [0, 0], [0, 0, 1], [0, 0, 1]]);
});

test('显式端口始终跳过 SRV，包括数字和字符串形式的默认端口', async (t) => {
  const { port, requests } = await mockServer(t);
  const connections = redirectConnections(t, port);
  const dns = t.mock.method(Resolver.prototype, 'resolveSrv', async () => {
    throw new Error('显式端口不应触发 SRV 查询');
  });
  for (const selectedPort of [25565, '25565', port, String(port)]) {
    assert.deepEqual(await new MCServerConnect('direct.example.test', selectedPort).getStatus(), expectedStatus);
  }
  assert.deepEqual(await queryStatus('direct.example.test', 25565), expectedStatus);
  assert.equal(dns.mock.callCount(), 0);
  const selectedPorts = [25565, 25565, port, port, 25565];
  assert.deepEqual(connections, selectedPorts.map((value) => ({ host: 'direct.example.test', port: value })));
  assert.deepEqual(requests.map((request) => request.handshake), connections);
});

test('省略端口的 IPv4 和 IPv6 地址跳过 SRV', async (t) => {
  const { port, requests } = await mockServer(t);
  const connections = redirectConnections(t, port);
  const dns = t.mock.method(Resolver.prototype, 'resolveSrv', async () => {
    throw new Error('IP 地址不应触发 SRV 查询');
  });
  for (const host of ['127.0.0.1', '::1']) {
    assert.deepEqual(await new MCServerConnect(host).getStatus(), expectedStatus);
  }
  assert.equal(dns.mock.callCount(), 0);
  assert.deepEqual(connections, [
    { host: '127.0.0.1', port: 25565 },
    { host: '::1', port: 25565 },
  ]);
  assert.deepEqual(requests.map((request) => request.handshake), connections);
});

for (const code of ['ENOTFOUND', 'ENODATA', 'empty']) {
  test(`SRV ${code} 回退到原域名和默认端口`, async (t) => {
    const { port, requests } = await mockServer(t);
    const connections = redirectConnections(t, port);
    t.mock.method(Resolver.prototype, 'resolveSrv', async () => {
      if (code === 'empty') return [];
      throw Object.assign(new Error('无 SRV 记录'), { code });
    });
    assert.deepEqual(await queryStatus('fallback.example.test'), expectedStatus);
    assert.deepEqual(connections, [{ host: 'fallback.example.test', port: 25565 }]);
    assert.deepEqual(requests[0].handshake, connections[0]);
  });
}

for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECANCELLED']) {
  test(`SRV ${code} 保留 DNS 错误原因且不回退连接`, async (t) => {
    const cause = Object.assign(new Error('测试 DNS 故障'), { code });
    t.mock.method(Resolver.prototype, 'resolveSrv', async () => { throw cause; });
    const connect = t.mock.method(Socket.prototype, 'connect', () => {
      throw new Error('DNS 故障后不应连接');
    });
    await assert.rejects(queryStatus('failure.example.test'), (error) => {
      assert.ok(error instanceof MCServerError);
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(connect.mock.callCount(), 0);
  });
}

for (const target of ['.', '']) {
  test(`SRV 目标 ${JSON.stringify(target)} 表示服务不可用`, async (t) => {
    t.mock.method(Resolver.prototype, 'resolveSrv', async () => [srvRecord(25565, { name: target })]);
    const connect = t.mock.method(Socket.prototype, 'connect', () => {
      throw new Error('服务明确不可用时不应连接');
    });
    await assert.rejects(queryStatus('unavailable.example.test'), { code: 'NETWORK_ERROR' });
    assert.equal(connect.mock.callCount(), 0);
  });
}

test('优先级较小的记录优先，同级记录按权重选择', async (t) => {
  const { port } = await mockServer(t);
  const connections = redirectConnections(t, port);
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [
    srvRecord(10001, { name: 'higher.example.test', priority: 10, weight: 65535 }),
    srvRecord(10002, { name: 'heavy.example.test', priority: 1, weight: 3 }),
    srvRecord(10003, { name: 'light.example.test', priority: 1, weight: 1 }),
  ]);
  const random = t.mock.method(Math, 'random', () => 0.3);
  await queryStatus('weighted.example.test');
  random.mock.mockImplementation(() => 0.9);
  await queryStatus('weighted.example.test');
  assert.deepEqual(connections, [
    { host: 'light.example.test', port: 10003 },
    { host: 'heavy.example.test', port: 10002 },
  ]);
});

test('同级权重全为零时仍能选择记录，且不受较高优先级记录影响', async (t) => {
  const { port } = await mockServer(t);
  const connections = redirectConnections(t, port);
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [
    srvRecord(10001, { name: 'higher.example.test', priority: 5, weight: 100 }),
    srvRecord(10002, { name: 'first.example.test', weight: 0 }),
    srvRecord(10003, { name: 'second.example.test', weight: 0 }),
  ]);
  const random = t.mock.method(Math, 'random', () => 0);
  await queryStatus('zero-weight.example.test');
  random.mock.mockImplementation(() => 0.99);
  await queryStatus('zero-weight.example.test');
  assert.deepEqual(connections, [
    { host: 'first.example.test', port: 10002 },
    { host: 'second.example.test', port: 10003 },
  ]);
});

test('同级混合权重在 RFC 2782 的零端点保留零权重记录的选择机会', async (t) => {
  const { port } = await mockServer(t);
  const connections = redirectConnections(t, port);
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [
    srvRecord(10001, { name: 'positive.example.test', weight: 10 }),
    srvRecord(10002, { name: 'zero.example.test', weight: 0 }),
  ]);
  const random = t.mock.method(Math, 'random', () => 0);
  await queryStatus('mixed-weight.example.test');
  random.mock.mockImplementation(() => 0.5);
  await queryStatus('mixed-weight.example.test');
  assert.deepEqual(connections, [
    { host: 'zero.example.test', port: 10002 },
    { host: 'positive.example.test', port: 10001 },
  ]);
});

test('SRV 目标末尾的根域名点不影响连接地址', async (t) => {
  const { port } = await mockServer(t);
  const connections = redirectConnections(t, port);
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [srvRecord(port, { name: 'target.example.test.' })]);
  assert.deepEqual(await queryStatus('play.example.test'), expectedStatus);
  assert.deepEqual(connections, [{ host: 'target.example.test', port }]);
});

test('选中的 SRV 目标连接失败时保留错误原因，且不尝试其他记录', async (t) => {
  const cause = Object.assign(new Error('测试连接失败'), { code: 'ECONNREFUSED' });
  t.mock.method(Resolver.prototype, 'resolveSrv', async () => [
    srvRecord(10001, { name: 'first.example.test' }),
    srvRecord(10002, { name: 'second.example.test' }),
  ]);
  t.mock.method(Math, 'random', () => 0);
  const connect = t.mock.method(Socket.prototype, 'connect', function () {
    process.nextTick(() => this.emit('error', cause));
    return this;
  });
  await assert.rejects(queryStatus('failure.example.test'), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(connect.mock.calls[0].arguments[0].host, 'first.example.test');
});

test('DNS 查询受整次请求超时约束，取消后迟到的结果不能建立连接', async (t) => {
  let completeDns;
  let activeResolver;
  t.mock.method(Resolver.prototype, 'resolveSrv', function () {
    activeResolver = this;
    return new Promise((resolve) => { completeDns = resolve; });
  });
  const cancel = t.mock.method(Resolver.prototype, 'cancel', () => {});
  const connect = t.mock.method(Socket.prototype, 'connect', () => {
    throw new Error('超时后不应连接');
  });
  await assert.rejects(queryStatus('slow.example.test', undefined, { timeout: 30 }), { code: 'TIMEOUT' });
  assert.ok(cancel.mock.calls.some((call) => call.this === activeResolver));
  completeDns([srvRecord(25565)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connect.mock.callCount(), 0);
});

test('DNS 解析与后续服务器响应共用一次总超时', async (t) => {
  // 两段延迟各自小于 200 ms，但总计 250 ms；解析完成后不能重置截止时间。
  const { port } = await mockServer(t, { statusDelay: 150 });
  t.mock.method(Resolver.prototype, 'resolveSrv', () => new Promise((resolve) => {
    setTimeout(() => resolve([srvRecord(port)]), 100);
  }));
  await assert.rejects(queryStatus('deadline.example.test', undefined, { timeout: 200 }), { code: 'TIMEOUT' });
});

test('并发请求各自持有 DNS 解析器，一个请求超时不取消另一个请求', async (t) => {
  const { port } = await mockServer(t);
  const resolvers = new Map();
  let completeSecondDns;
  t.mock.method(Resolver.prototype, 'resolveSrv', function (name) {
    resolvers.set(name, this);
    return new Promise((resolve) => {
      if (name === '_minecraft._tcp.second.example.test') completeSecondDns = resolve;
    });
  });
  const cancel = t.mock.method(Resolver.prototype, 'cancel', () => {});
  const first = queryStatus('first.example.test', undefined, { timeout: 30 });
  const second = queryStatus('second.example.test', undefined, { timeout: 1000 });
  await assert.rejects(first, { code: 'TIMEOUT' });
  const firstResolver = resolvers.get('_minecraft._tcp.first.example.test');
  const secondResolver = resolvers.get('_minecraft._tcp.second.example.test');
  assert.notEqual(firstResolver, secondResolver);
  assert.ok(cancel.mock.calls.some((call) => call.this === firstResolver));
  assert.ok(cancel.mock.calls.every((call) => call.this !== secondResolver));
  completeSecondDns([srvRecord(port)]);
  assert.deepEqual(await second, expectedStatus);
});
