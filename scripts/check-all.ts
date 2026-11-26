const GATES = [
  'lint',
  'typecheck',
  'test:ci',
  'depcruise',
  'knip',
  'dupcheck',
  'build',
] as const

const failed: string[] = []

for (const gate of GATES) {
  process.stdout.write(`\n==> bun run ${gate}\n`)
  const result = Bun.spawnSync(['bun', 'run', gate], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    failed.push(gate)
  }
}

if (failed.length > 0) {
  process.stderr.write(`\nFailed gates: ${failed.join(', ')}\n`)
  process.exit(1)
}
