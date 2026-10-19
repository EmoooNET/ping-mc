import type { SrvRecord } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MCServerError } from './errors.js';
import type { ConnectionOptions } from './options.js';

interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

/** 优先选择数值最小的优先级，再按同级记录的权重选择本次连接目标。 */
function selectRecord(records: readonly SrvRecord[]): SrvRecord | undefined {
  if (records.length === 0) return undefined;

  const priority = Math.min(...records.map((record) => record.priority));
  const candidates = records.filter((record) => record.priority === priority);
  const totalWeight = candidates.reduce((sum, record) => sum + record.weight, 0);
  if (totalWeight === 0) return candidates[Math.floor(Math.random() * candidates.length)];

  // RFC 2782 将零权重记录放在前面，并在含端点的区间内抽样。
  candidates.sort((left, right) => left.weight - right.weight);
  const selectedWeight = Math.floor(Math.random() * (totalWeight + 1));
  let accumulatedWeight = 0;
  for (const record of candidates) {
    accumulatedWeight += record.weight;
    if (accumulatedWeight >= selectedWeight) return record;
  }
  return undefined;
}

/** 仅解析 TCP 目标；握手与实例属性继续使用调用方传入的地址。 */
export async function resolveServerAddress(
  options: ConnectionOptions,
  signal: AbortSignal,
): Promise<ServerAddress> {
  const address = { host: options.host, port: options.port };
  if (!options.resolveSrv || isIP(options.host) !== 0) return address;

  signal.throwIfAborted();
  // 每次请求独占解析器，超时取消时不会影响其他实例或并发查询。
  const resolver = new Resolver();
  const cancel = (): void => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });

  try {
    const records = await resolver.resolveSrv(`_minecraft._tcp.${options.host}`);
    signal.throwIfAborted();
    const record = selectRecord(records);
    if (record === undefined) return address;

    // 根域名表示服务明确不可用；Node.js 也可能将它表示为空字符串。
    if (record.name === '.' || record.name === '') {
      throw new MCServerError('NETWORK_ERROR', `Minecraft service is unavailable for ${options.host}`);
    }
    if (record.port < 1 || record.port > 65535) {
      throw new MCServerError('NETWORK_ERROR', `SRV record for ${options.host} has an invalid port`);
    }

    // DNS 的绝对域名可带末尾的点，移除后交给 socket 解析 A / AAAA。
    return { host: record.name.replace(/\.$/, ''), port: record.port };
  } catch (cause) {
    // 只有确认不存在记录时才回退；解析故障需保留原因，避免掩盖 DNS 问题。
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return address;
    if (cause instanceof MCServerError) throw cause;
    throw new MCServerError('NETWORK_ERROR', `Could not resolve Minecraft SRV record for ${options.host}`, { cause });
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}
