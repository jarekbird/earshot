// Fact: what a listener throws may carry what was heard, so only this sentence leaves.
function report(of: string): void {
  const said = `Earshot: a listener of the ${of} threw.`
  if (typeof reportError === 'function') reportError(new Error(said))
  else console.error(said)
}

export function serve(call: () => unknown, of = 'microphone'): void {
  try {
    const answer = call()
    if (typeof (answer as { then?: unknown } | null | undefined)?.then === 'function') Promise.resolve(answer).catch(() => report(of))
  } catch {
    report(of)
  }
}
