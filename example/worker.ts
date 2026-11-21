import { relay } from '../relay/relay.js'

interface Env {
  OPENROUTER_KEY: string
  UPSTREAM: string
}

export default {
  fetch: (request: Request, env: Env) => relay({ key: env.OPENROUTER_KEY, upstream: env.UPSTREAM })(request),
}
