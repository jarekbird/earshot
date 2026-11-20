// Even Hub's submission rules, hub.evenrealities.com/docs/ship/app-submission
export const EDITION = '202601'

export interface ProjectFacts {
  packageVersion?: string
  sdkVersion?: string
  hasFile?: (path: string) => boolean
}

const ORIGIN_EXAMPLE = 'such as "https://api.example.com" or "wss://*.example.com"'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function originOf(entry: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(entry)) return null
  try {
    return new URL(entry.replace('://*.', '://wildcard.'))
  } catch {
    return null
  }
}

export function whitelistOf(manifest: unknown): string[] {
  const permissions = isRecord(manifest) && Array.isArray(manifest.permissions) ? manifest.permissions : []
  const network = permissions.find(p => isRecord(p) && p.name === 'network')
  const whitelist = isRecord(network) && Array.isArray(network.whitelist) ? network.whitelist : []
  return whitelist.filter((entry): entry is string => typeof entry === 'string')
}

function permissionProblems(permissions: unknown): string[] {
  if (!Array.isArray(permissions) || !permissions.every(isRecord)) return ['permissions must be a list of { name, desc }.']
  const problems: string[] = []
  for (const permission of permissions) {
    const { name, desc, whitelist } = permission
    if (typeof name !== 'string' || !name) {
      problems.push('A permission has no name.')
      continue
    }
    const length = typeof desc === 'string' ? desc.length : 0
    if (length < 1 || length > 300) problems.push(`Permission "${name}" needs a description of 1 to 300 characters; it has ${length}.`)
    if (name !== 'network') continue
    if (!Array.isArray(whitelist) || !whitelist.length) {
      problems.push('Permission "network" needs a whitelist with at least one origin.')
      continue
    }
    for (const entry of whitelist) {
      if (typeof entry !== 'string' || !originOf(entry))
        problems.push(`Whitelist entry ${JSON.stringify(entry)} must be an origin, ${ORIGIN_EXAMPLE}.`)
    }
  }
  return problems
}

export function manifestProblems(manifest: unknown, facts: ProjectFacts = {}): string[] {
  if (!isRecord(manifest)) return ['The manifest is not a JSON object.']
  const problems: string[] = []
  const { package_id, edition, name, version, min_sdk_version, entrypoint } = manifest
  const shown = (value: unknown) => JSON.stringify(value)

  if (typeof package_id !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(package_id))
    problems.push(
      `package_id ${shown(package_id)} must be reverse-domain: two or more parts, each lowercase letters and digits starting with a letter.`,
    )

  if (edition !== EDITION) problems.push(`edition ${shown(edition)} must be "${EDITION}".`)

  if (typeof name !== 'string' || !name) problems.push('name is missing.')
  else {
    if (name.length > 20) problems.push(`name ${shown(name)} is ${name.length} characters; the limit is 20.`)
    if (name.toLowerCase().includes('even')) problems.push(`name ${shown(name)} contains "Even", which the store rejects.`)
  }

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    problems.push(`version ${shown(version)} must be three numbers, x.y.z.`)
  else if (facts.packageVersion !== undefined && version !== facts.packageVersion)
    problems.push(`version ${shown(version)} differs from package.json, which says ${shown(facts.packageVersion)}.`)

  if (typeof min_sdk_version !== 'string' || !min_sdk_version) problems.push('min_sdk_version is missing.')
  else if (facts.sdkVersion !== undefined && min_sdk_version !== facts.sdkVersion)
    problems.push(`min_sdk_version ${shown(min_sdk_version)} differs from the installed SDK, ${shown(facts.sdkVersion)}.`)

  if (typeof entrypoint !== 'string' || !entrypoint) problems.push('entrypoint is missing.')
  else if (facts.hasFile && !facts.hasFile(entrypoint)) problems.push(`entrypoint ${shown(entrypoint)} is not a file in the build.`)

  return [...problems, ...permissionProblems(manifest.permissions)]
}
