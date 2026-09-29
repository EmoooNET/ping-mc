import type { MCServerOptions } from './types.js';

export interface ConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly timeout: number;
  readonly protocolVersion: number;
}

export function normalizeOptions(
  host: string,
  port: number | string,
  options: MCServerOptions,
): ConnectionOptions {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /\s|\0/.test(host)) {
    throw new TypeError('host must be a non-empty hostname or IP address (at most 255 characters)');
  }

  if (typeof port !== 'number' && (typeof port !== 'string' || !/^\d+$/.test(port))) {
    throw new TypeError('port must be an integer or a decimal integer string');
  }
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new RangeError('port must be between 1 and 65535');
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const timeout = options.timeout ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new RangeError('timeout must be an integer between 1 and 2147483647 milliseconds');
  }
  const protocolVersion = options.protocolVersion ?? -1;
  if (!Number.isInteger(protocolVersion) || protocolVersion < -2_147_483_648 || protocolVersion > 2_147_483_647) {
    throw new RangeError('protocolVersion must be a signed 32-bit integer');
  }

  return Object.freeze({ host, port: numericPort, timeout, protocolVersion });
}
