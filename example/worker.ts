import { relay, relayOptions } from '../relay/relay.js'

interface Env {
  OPENROUTER_KEY: string
  UPSTREAM: string
  MODELS?: string
}

export default {
  fetch: (request: Request, env: Env) =>
    relay(relayOptions({ key: env.OPENROUTER_KEY, upstream: env.UPSTREAM, models: env.MODELS }))(request),
}
