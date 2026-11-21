export class SayError extends Error {
  constructor(readonly say: string) {
    super(say)
    this.name = 'SayError'
  }
}
