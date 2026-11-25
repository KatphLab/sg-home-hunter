const result = Bun.spawnSync(
  [
    'semgrep',
    'scan',
    '--error',
    '--config',
    'p/owasp-top-ten',
    '--config',
    'p/nodejs',
    '--config',
    'p/typescript',
    '--config',
    'p/secrets',
    '--config',
    '.semgrep.yml',
    '.',
  ],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

process.exit(result.exitCode)
