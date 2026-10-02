"""Exercise the release's real readiness function without touching any service."""
from pathlib import Path
import subprocess
import tempfile
import sys

script_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("release-main-unify-20261001-bt.sh")
script = script_path.read_text()
health = script[script.index("health() {"):script.index("\nverify() {")]

cases = [
    ("transient connection refusal", "transient", "healthy", 0),
    ("endpoint never ready", "failed", "healthy", 1),
    ("worker remains starting", "ready", "starting", 1),
]
for name, endpoint, worker, expected in cases:
    with tempfile.TemporaryDirectory() as directory:
        invocation = "health; echo HEALTH_PASS" if expected == 0 else "if health; then echo HEALTH_PASS; else exit 1; fi"
        harness = f'''set -Eeuo pipefail
bt="{directory}"
trap 'echo EARLY_ERR_TRAP >&2' ERR
curl() {{
  if [[ "{endpoint}" == failed ]]; then printf '000'; return 7; fi
  if [[ "{endpoint}" == transient && ! -f "$bt/ready" ]]; then
    touch "$bt/ready"; printf '000'; return 7
  fi
  printf '200'
}}
docker() {{ printf '{worker}'; }}
sleep() {{ :; }}
{health}
{invocation}
'''
        result = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
        assert result.returncode == expected, (name, result.stdout, result.stderr)
        assert "EARLY_ERR_TRAP" not in result.stderr, (name, result.stderr)
        if expected:
            assert "HEALTH_FAILED" in result.stdout
            assert "READINESS attempt=30" in result.stdout
        else:
            assert "control=000" in result.stdout and "HEALTH_PASS" in result.stdout
        print(f"PASS: {name}")
