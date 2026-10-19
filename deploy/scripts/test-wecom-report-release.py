"""Exercise release/rollback sequencing with a local fake Docker CLI. No host/network mutations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('release-wecom-report-delivery-20261019.sh').resolve()
SHA = 'a' * 40
FAKE = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['FAKE_ROOT']);p=root/'mock.json';s=json.loads(p.read_text());a=sys.argv[1:]
with (root/'calls.jsonl').open('a') as f:f.write(json.dumps(a)+'\\n')
if a[:2]==['image','inspect']:print(os.environ['FAKE_SHA'])
elif a[0]=='inspect':
 fmt=a[a.index('--format')+1]
 if 'range .Config.Env' in fmt:print('DB_PASSWORD=fixture-private-secret')
 elif fmt=='{{.Config.Image}}':print(s['image'])
 elif fmt=='{{.State.Health.Status}}':print('healthy')
 elif fmt=='{{index .Config.Labels "org.opencontainers.image.revision"}}':print(os.environ['FAKE_SHA'])
 else:print(s['image']+' '+os.environ['FAKE_SHA']+' healthy')
elif a[0]=='exec':
 if 'pg_dump' in ' '.join(a):print('fixture-backup')
 elif 'psql' in ' '.join(a):print(s['head'])
 elif 'report-rollback-compat' in a:
  if os.environ.get('FAKE_PENDING')=='1':sys.exit(2)
  print('COMPATIBILITY_GUARDS_APPLIED')
 else:print('VERIFIED')
elif a[0]=='run':
 if 'migrateTo' in ' '.join(a):s['head']='0090_report_delivery';print('MIGRATION_0090_OK')
elif a[0]=='compose':
 assert a[-1]=='worker' and '--no-deps' in a and '--no-build' in a
 files=[a[i+1] for i,v in enumerate(a) if v=='-f'];s['image']=json.loads(Path(files[-1]).read_text())['services']['worker']['image']
else:sys.exit(2)
p.write_text(json.dumps(s))
'''

class ReleaseContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wecom-release-test-')
        self.root = Path(self.tmp.name)
        (self.root/'docker').write_text(FAKE)
        (self.root/'docker').chmod(0o700)
        (self.root/'date').write_text('#!/bin/sh\nprintf 12')
        (self.root/'date').chmod(0o700)
        (self.root/'mock.json').write_text(json.dumps({'image':'previous-worker','head':'0089_model_validation_binding'}))
        self.env = {**os.environ, 'PATH':str(self.root)+os.pathsep+os.environ['PATH'], 'FAKE_ROOT':str(self.root), 'FAKE_SHA':SHA,
                    'WECOM_RELEASE_IMAGE':'candidate-worker', 'WECOM_RELEASE_COMPOSE_DIR':str(self.root),
                    'WECOM_RELEASE_COMPOSE_FILE':str(self.root/'compose.yaml'), 'WECOM_RELEASE_STATE_DIR':str(self.root/'private-state'),
                    'WECOM_REPORT_DELIVERY_ENABLED_AT':'2030-01-01T00:00:00Z'}
    def tearDown(self):
        self.tmp.cleanup()
    def run_mode(self,mode,success=True):
        result=subprocess.run(['bash',str(SCRIPT),mode,SHA],env=self.env,capture_output=True,text=True)
        self.assertEqual(result.returncode==0,success,result.stdout+result.stderr)
        self.assertNotIn('fixture-private-secret',result.stdout+result.stderr)
        return result
    def test_readonly_preflight(self):
        self.run_mode('--preflight')
        self.assertFalse((self.root/'private-state').exists())
        self.assertEqual(json.loads((self.root/'mock.json').read_text())['head'],'0089_model_validation_binding')
    def test_migrate_deploy_verify_rollback_only_worker(self):
        for mode in ['--migrate','--deploy','--verify','--rollback']:self.run_mode(mode)
        state=json.loads((self.root/'mock.json').read_text())
        self.assertEqual(state,{'head':'0090_report_delivery','image':'previous-worker'})
        self.assertEqual((self.root/'private-state/worker-private.env').stat().st_mode & 0o777,0o600)
        calls=[json.loads(line) for line in (self.root/'calls.jsonl').read_text().splitlines()]
        self.assertEqual(len([call for call in calls if call[0]=='compose']),2)
    def test_rollback_refuses_inflight_receipts(self):
        self.run_mode('--migrate');self.run_mode('--deploy');self.env['FAKE_PENDING']='1'
        self.run_mode('--rollback',success=False)
        self.assertEqual(json.loads((self.root/'mock.json').read_text())['image'],'candidate-worker')

if __name__=='__main__':unittest.main()
