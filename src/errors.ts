export type MCServerErrorCode =
  | 'TIMEOUT'
  | 'CONNECTION_CLOSED'
  | 'NETWORK_ERROR'
  | 'PROTOCOL_ERROR';

/** 网络或协议错误；底层错误可通过 cause 获取。 */
export class MCServerError extends Error {
  override readonly name = 'MCServerError';

  constructor(
    public readonly code: MCServerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
