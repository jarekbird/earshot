#!/usr/bin/env node
import type { AddressInfo } from 'node:net'
import { serve, settings } from './node.js'

try {
  const server = await serve(settings(process.env))
  console.log(`Earshot relay on port ${(server.address() as AddressInfo).port}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
