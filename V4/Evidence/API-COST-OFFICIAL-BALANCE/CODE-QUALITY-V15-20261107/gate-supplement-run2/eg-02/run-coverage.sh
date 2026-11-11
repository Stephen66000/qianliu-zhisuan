#!/bin/zsh
set -o pipefail
export DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock
export TESTCONTAINERS_RYUK_DISABLED=true
RUNDIR="/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/CODE-QUALITY-V15-20261107/gate-supplement-run2/eg-02"
cd /Users/mac/Projects/仟流智算-api-decouple
{
  echo "start: $(date +%F' '%T)"
  echo "cmd: corepack pnpm@11.11.0 exec vitest run --config vitest.eg02.config.ts --coverage"
} > "$RUNDIR/coverage-run.meta"
corepack pnpm@11.11.0 exec vitest run --config vitest.eg02.config.ts --coverage 2>&1 | tee "$RUNDIR/coverage-run.log"
code=$?
{
  echo "end: $(date +%F' '%T)"
  echo "exit_code: $code"
} >> "$RUNDIR/coverage-run.meta"
exit $code
