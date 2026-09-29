import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { decodeVarInt, encodePacket, encodeString, encodeVarInt } from './codec.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createHandshake(host: string, port: number, protocolVersion: number): Buffer {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('Port must be an integer between 1 and 65535.');
  }
  if (host.length < 1 || host.length > 255) {
    throw new RangeError('Handshake host must contain between 1 and 255 characters.');
  }

  const encodedPort = Buffer.allocUnsafe(2);
  encodedPort.writeUInt16BE(port);
  return encodePacket(0x00, Buffer.concat([
    encodeVarInt(protocolVersion),
    encodeString(host),
    encodedPort,
    encodeVarInt(1), // Next state: status.
  ]));
}

export function createStatusRequest(): Buffer {
  return encodePacket(0x00);
}

export function createPingRequest(payload: bigint): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigInt64BE(payload);
  return encodePacket(0x01, bytes);
}

/** Decodes the wire representation; the status layer validates the JSON structure. */
export function decodeStatusResponse(packet: Buffer): unknown {
  const id = decodeVarInt(packet);
  if (id === undefined || id.value !== 0x00) {
    throw new Error('Expected a status response packet (0x00).');
  }

  const length = decodeVarInt(packet, id.size);
  if (length === undefined || length.value < 0) {
    throw new Error('Status response has an invalid JSON string length.');
  }

  const start = id.size + length.size;
  if (packet.length - start !== length.value) {
    throw new Error('Status response JSON length does not match its packet length.');
  }

  return JSON.parse(utf8Decoder.decode(packet.subarray(start))) as unknown;
}

export function decodePongResponse(packet: Buffer): bigint {
  const id = decodeVarInt(packet);
  if (id === undefined || id.value !== 0x01) {
    throw new Error('Expected a pong response packet (0x01).');
  }
  if (packet.length - id.size !== 8) {
    throw new Error('Pong response must contain exactly 8 payload bytes.');
  }

  return packet.readBigInt64BE(id.size);
}
