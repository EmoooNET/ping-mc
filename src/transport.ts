import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { MCServerError } from './errors.js';
import type { ConnectionOptions } from './options.js';
import { PacketDecoder } from './protocol/codec.js';
import {
  createHandshake,
  createPingRequest,
  createStatusRequest,
  decodePongResponse,
  decodeStatusResponse,
} from './protocol/packets.js';
import { parseStatus } from './status.js';
import type { MCServerStatus, MCServerStatusWithPing } from './types.js';

export function requestStatus(options: ConnectionOptions, withPing: false): Promise<MCServerStatus>;
export function requestStatus(options: ConnectionOptions, withPing: true): Promise<MCServerStatusWithPing>;
export function requestStatus(
  options: ConnectionOptions,
  withPing: boolean,
): Promise<MCServerStatus | MCServerStatusWithPing> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const decoder = new PacketDecoder();
    let settled = false;
    let status: MCServerStatus | undefined;
    let pingToken = 0n;
    let pingStarted = 0;

    // 使用整次请求的截止时间，避免持续收到零碎字节导致请求永不超时。
    const timer = setTimeout(() => {
      fail(new MCServerError('TIMEOUT', `Server query timed out after ${options.timeout} ms`));
    }, options.timeout);

    function finish(error?: MCServerError, result?: MCServerStatus): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    }

    function fail(error: MCServerError): void {
      finish(error);
    }

    socket.once('connect', () => {
      if (settled) return;
      socket.setNoDelay(true);
      socket.write(Buffer.concat([
        createHandshake(options.host, options.port, options.protocolVersion),
        createStatusRequest(),
      ]));
    });

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        for (const packet of decoder.push(chunk)) {
          if (status === undefined) {
            status = parseStatus(decodeStatusResponse(packet));
            if (!withPing) {
              finish(undefined, status);
              return;
            }
            // 使用随机 Long 校验回包；单调时钟只测量 Ping/Pong 的往返耗时。
            pingToken = randomBytes(8).readBigInt64BE();
            const pingPacket = createPingRequest(pingToken);
            pingStarted = performance.now();
            socket.write(pingPacket);
          } else {
            if (decodePongResponse(packet) !== pingToken) {
              throw new Error('Pong payload does not match the ping request');
            }
            const result: MCServerStatusWithPing = { ...status, latency: performance.now() - pingStarted };
            finish(undefined, result);
            return;
          }
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Invalid server response';
        fail(new MCServerError('PROTOCOL_ERROR', detail, { cause }));
      }
    });

    socket.on('error', (cause: Error) => {
      fail(new MCServerError('NETWORK_ERROR', `Could not query ${options.host}:${options.port}: ${cause.message}`, { cause }));
    });
    socket.once('end', () => {
      fail(new MCServerError('CONNECTION_CLOSED', 'Server closed the connection before the response was complete'));
    });
    socket.once('close', () => {
      fail(new MCServerError('CONNECTION_CLOSED', 'Connection closed before the response was complete'));
    });

    try {
      socket.connect({ host: options.host, port: options.port });
    } catch (cause) {
      fail(new MCServerError('NETWORK_ERROR', 'Could not open the server connection', { cause }));
    }
  });
}
