#!/usr/bin/env node
import { checkApp } from './app.js'
import { command } from './command.js'

const { code, lines } = command(process.argv.slice(2), checkApp)
for (const line of lines) (code ? console.error : console.log)(line)
process.exit(code)
