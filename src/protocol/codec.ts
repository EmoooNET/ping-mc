import { Buffer } from 'node:buffer';

const MAX_INT32 = 0x7fff_ffff;
const DEFAULT_MAX_PACKET_SIZE = 2 * 1024 * 1024;

export interface DecodedVarInt {
  value: number;
  size: number;
}

/** Minecraft VarInts encode signed 32-bit values without ZigZag encoding. */
export function encodeVarInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > MAX_INT32) {
    throw new RangeError('VarInt value must be a signed 32-bit integer.');
  }

  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);

  return Buffer.from(bytes);
}

/** Returns undefined when more bytes are needed, but throws for invalid encodings. */
export function decodeVarInt(buffer: Buffer, offset = 0): DecodedVarInt | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > buffer.length) {
    throw new RangeError('VarInt offset must be within the buffer.');
  }

  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = buffer[offset + index];
    if (byte === undefined) return undefined;
    if (index === 4 && (byte & 0x80) !== 0) {
      throw new RangeError('VarInt cannot exceed 5 bytes.');
    }
    if (index === 4 && (byte & 0x70) !== 0) {
      throw new RangeError('VarInt exceeds 32 bits.');
    }

    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return { value, size: index + 1 };
  }

  throw new RangeError('Invalid VarInt.');
}

export function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

/** Adds the packet ID and the uncompressed packet-length prefix. */
export function encodePacket(id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (id < 0) throw new RangeError('Packet ID must be nonnegative.');
  const encodedId = encodeVarInt(id);
  return Buffer.concat([
    encodeVarInt(encodedId.length + payload.length),
    encodedId,
    payload,
  ]);
}

/** Reassembles TCP fragments and splits coalesced packets into complete bodies. */
export class PacketDecoder {
  private readonly lengthBytes = Buffer.alloc(5);
  private lengthSize = 0;
  private packet: Buffer | undefined;
  private packetOffset = 0;

  constructor(private readonly maxPacketSize = DEFAULT_MAX_PACKET_SIZE) {
    if (!Number.isInteger(maxPacketSize) || maxPacketSize < 1 || maxPacketSize > MAX_INT32) {
      throw new RangeError('Maximum packet size must be a positive 32-bit integer.');
    }
  }

  push(chunk: Buffer): Buffer[] {
    const packets: Buffer[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      if (this.packet === undefined) {
        this.lengthBytes[this.lengthSize] = chunk[offset]!;
        this.lengthSize += 1;
        offset += 1;

        const length = decodeVarInt(this.lengthBytes.subarray(0, this.lengthSize));
        if (length === undefined) continue;
        if (length.value < 1 || length.value > this.maxPacketSize) {
          throw new RangeError(`Packet length must be between 1 and ${this.maxPacketSize} bytes.`);
        }

        // Allocate once per packet so heavily fragmented responses stay linear in size.
        this.packet = Buffer.allocUnsafe(length.value);
        this.lengthSize = 0;
      }

      const copied = chunk.copy(this.packet, this.packetOffset, offset);
      offset += copied;
      this.packetOffset += copied;

      if (this.packetOffset === this.packet.length) {
        packets.push(this.packet);
        this.packet = undefined;
        this.packetOffset = 0;
      }
    }

    return packets;
  }
}
