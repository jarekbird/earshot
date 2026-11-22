export interface Failure {
  status?: number
  cause?: unknown
}

export class SayError extends Error {
  readonly status?: number

  constructor(
    readonly say: string,
    { status, cause }: Failure = {},
  ) {
    super(say, cause === undefined ? undefined : { cause })
    this.name = 'SayError'
    if (status !== undefined) this.status = status
  }
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RelayError'
  }
}
