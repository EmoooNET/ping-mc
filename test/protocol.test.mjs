import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { decodeVarInt, encodePacket, encodeString, encodeVarInt, PacketDecoder } from '../dist/protocol/codec.js';
import { createHandshake, createPingRequest, createStatusRequest, decodePongResponse, decodeStatusResponse } from '../dist/protocol/packets.js';

test('VarInt encoding matches signed protocol fixtures', () => {
  const fixtures = [
    [0, '00'],
    [127, '7f'],
    [128, '8001'],
    [255, 'ff01'],
    [2147483647, 'ffffffff07'],
    [-1, 'ffffffff0f'],
    [-2147483648, '8080808008'],
  ];

  for (const [value, hex] of fixtures) {
    const encoded = Buffer.from(hex, 'hex');
    assert.deepEqual(encodeVarInt(value), encoded);
    assert.deepEqual(decodeVarInt(encoded), { value, size: encoded.length });
  }
  assert.deepEqual(decodeVarInt(Buffer.from([0xff, 0x80, 0x01]), 1), { value: 128, size: 2 });
});

test('VarInt distinguishes incomplete input from malformed or overflowing input', () => {
  for (const hex of ['', '80', 'ffffff', 'ffffffff']) {
    assert.equal(decodeVarInt(Buffer.from(hex, 'hex')), undefined);
  }
  for (const hex of ['8080808080', '8080808010', 'ffffffff7f']) {
    assert.throws(() => decodeVarInt(Buffer.from(hex, 'hex')), RangeError);
  }
  for (const value of [-2147483649, 2147483648, 1.5, NaN, Infinity]) {
    assert.throws(() => encodeVarInt(value), RangeError);
  }
  assert.throws(() => decodeVarInt(Buffer.alloc(0), -1), RangeError);
  assert.throws(() => decodeVarInt(Buffer.alloc(0), 1), RangeError);
});

test('strings use UTF-8 byte lengths and handshake uses the status state', () => {
  assert.deepEqual(encodeString('你好'), Buffer.from('06e4bda0e5a5bd', 'hex'));
  assert.deepEqual(createStatusRequest(), Buffer.from([1, 0]));
  assert.deepEqual(
    createHandshake('localhost', 25565, -1),
    Buffer.from('1300ffffffff0f096c6f63616c686f737463dd01', 'hex'),
  );
});

test('packet decoder handles fragmentation across all boundaries and coalesced frames', () => {
  const bodies = [Buffer.from([0]), Buffer.alloc(300, 0x12), Buffer.from([1, 2, 3])];
  const wire = Buffer.concat(bodies.map((body) => Buffer.concat([encodeVarInt(body.length), body])));

  for (let split = 0; split <= wire.length; split += 1) {
    const decoder = new PacketDecoder();
    assert.deepEqual([...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))], bodies);
  }

  const decoder = new PacketDecoder();
  assert.deepEqual([...wire].flatMap((byte) => decoder.push(Buffer.from([byte]))), bodies);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
});

test('packet decoder rejects illegal lengths before buffering their bodies', () => {
  for (const value of [0, -1, 2 * 1024 * 1024 + 1]) {
    assert.throws(() => new PacketDecoder().push(encodeVarInt(value)), RangeError);
  }
  assert.throws(() => new PacketDecoder(10).push(encodeVarInt(11)), RangeError);
  assert.throws(() => new PacketDecoder().push(Buffer.from('8080808080', 'hex')), RangeError);
  assert.throws(() => new PacketDecoder(0), RangeError);
});

test('status response decodes UTF-8 JSON and rejects malformed wire data', () => {
  const status = { description: { text: '你好' }, players: { online: 1, max: 10 } };
  const [packet] = new PacketDecoder().push(encodePacket(0, encodeString(JSON.stringify(status))));
  assert.deepEqual(decodeStatusResponse(packet), status);

  const invalid = [
    Buffer.alloc(0),
    Buffer.from([1, 2, 0x7b, 0x7d]), // Wrong packet ID.
    Buffer.from([0, 0x80]), // Truncated length.
    Buffer.concat([Buffer.from([0]), encodeVarInt(-1)]),
    Buffer.from([0, 1, 0x7b, 0x7d]), // Trailing bytes.
    Buffer.from([0, 3, 0x7b, 0x7d]), // Truncated JSON.
    Buffer.from([0, 3, 0x22, 0xff, 0x22]), // Invalid UTF-8 inside otherwise valid JSON.
    Buffer.from([0, 1, 0x7b]), // Invalid JSON.
  ];
  for (const value of invalid) assert.throws(() => decodeStatusResponse(value));
});

test('ping and pong carry exactly one signed big-endian 64-bit payload', () => {
  const payload = 0x0102030405060708n;
  assert.deepEqual(createPingRequest(payload), Buffer.from('09010102030405060708', 'hex'));
  assert.equal(decodePongResponse(Buffer.from('010102030405060708', 'hex')), payload);
  assert.equal(decodePongResponse(Buffer.from('01ffffffffffffffff', 'hex')), -1n);

  for (const hex of ['', '000102030405060708', '010102', '01010203040506070809']) {
    assert.throws(() => decodePongResponse(Buffer.from(hex, 'hex')));
  }
});
