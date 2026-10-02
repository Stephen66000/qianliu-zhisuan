#!/usr/bin/env bash
# Deploy the weekly report rasterization fix to the existing Worker only.
set -Eeuo pipefail
umask 077
mode="${1:---check-contract}"
if [[ "$mode" == --check-contract ]]; then bash -n "$0"; exit 0; fi
revision="${2:?Approved full SHA required}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
case "$mode" in --prepare|--build|--deploy) ;; *) exit 2;; esac
repo=/root/docker/qianliu-zhisuan
release="/root/docker/qianliu-weekly-retina-${revision:0:12}"
bt="$release/deploy/bt"
exec 9>/root/docker/.qianliu-unify-release.lock
flock -n 9 || { echo 'Another release is running'; exit 2; }
compose() { docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/runtime.json" -f "$bt/worker.json" "$@"; }
case "$mode" in
  --prepare)
    [[ -z "$(git -C "$repo" status --porcelain -uno)" ]] || exit 2
    GIT_TERMINAL_PROMPT=0 git -C "$repo" fetch origin main
    [[ "$(git -C "$repo" rev-parse origin/main)" == "$revision" ]] || exit 2
    [[ ! -e "$release" ]] || { echo 'Release exists; inspect before reuse'; exit 2; }
    base="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ic-worker)"
    case "$base" in /root/docker/qianliu-unified-*/deploy/bt|/root/docker/qianliu-report-retina-*/deploy/bt) ;; *) exit 2;; esac
    mkdir "$release"
    git -C "$repo" archive "$revision" | tar -x -C "$release"
    mkdir -p "$bt"
    cp "$base/compose.yaml" "$base/runtime.json" "$base/.env" "$bt/"
    python3 - "$bt" "$revision" <<'PY'
import json,pathlib,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
pins=json.loads((bt.parent.parent/'V4/Evidence/WEEKLY-REPORT-RETINA-20261002/baseline.json').read_text())
state={}
for service in ['control-api','gateway','worker','web']:
    live=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    assert live['Image']==pins[service],'Production baseline changed: '+service
    state[service]={'image':live['Image'],'env':live['Config']['Env'],'ports':live['HostConfig']['PortBindings'],
        'mounts':live['Mounts'],'cmd':live['Config']['Cmd'],'startedAt':live['State']['StartedAt']}
old='ic-worker:rollback-weekly-'+revision[:12]
subprocess.check_call(['docker','tag',state['worker']['image'],old])
for name,data in [('state.json',state),('worker.json',{'services':{'worker':{'image':'ic-worker:weekly-'+revision[:12],
    'build':{'args':{'SOURCE_REVISION':revision}},'labels':{'io.qianliu.source.revision':revision}}}}),
    ('worker-rollback.json',{'services':{'worker':{'image':old}}})]:
    (bt/name).write_text(json.dumps(data,indent=2)+'\n')
print('Worker rollback image and effective configuration recorded')
PY
    compose config --quiet
    echo "PREPARED revision=$revision release=$release"
    ;;
  --build)
    compose build worker
    [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-worker:weekly-${revision:0:12}")" == "$revision" ]]
    # Override the image entrypoint: render synthetic data without starting the scheduler.
    mkdir -p "$bt/samples"
    docker run --rm --network none --entrypoint node -v "$bt/samples:/tmp/weekly-retina-samples" \
      "ic-worker:weekly-${revision:0:12}" --import tsx --input-type=module \
      -e "$(cat "$release/V4/Evidence/WEEKLY-REPORT-RETINA-20261002/render-samples.mjs")" \
      > "$bt/linux-samples.json" 2> "$bt/linux-samples-errors.log"
    python3 - "$bt/linux-samples.json" <<'PYVERIFY'
import json,sys
sample=json.load(open(sys.argv[1]));assert sample['platform']=='linux'
expected={'company':[1080,1520],'personal':[1080,1538],'daily':[1080,1520]}
assert len(sample['results'])==3
for item in sample['results']:
    assert item['decodedSize']==expected[item['kind']]
    assert [item['width'],item['height']]==expected[item['kind']]
    assert item['matchesHighResolutionReference'] and item['syntheticData']
print(json.dumps(sample,indent=2))
PYVERIFY
    echo BUILD_PASS
    ;;
  --deploy)
    python3 - "$bt" <<'PY'
import json,pathlib,subprocess,sys
state=json.loads((pathlib.Path(sys.argv[1])/'state.json').read_text())
for service,item in state.items():
    live=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    assert live['Image']==item['image'] and live['Config']['Env']==item['env'],'Production changed since prepare: '+service
PY
    [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-worker:weekly-${revision:0:12}")" == "$revision" ]]
    rollback() {
      docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/runtime.json" -f "$bt/worker-rollback.json" \
        up -d --no-deps --no-build --force-recreate worker
      echo 'ROLLBACK: previous Worker image and configuration restored'
    }
    on_error() { local rc=$?; trap - ERR; rollback || true; exit "$rc"; }
    trap on_error ERR
    compose up -d --no-deps --no-build --force-recreate worker
    healthy=0
    for attempt in $(seq 1 30); do
      status="$(docker inspect --format '{{.State.Health.Status}}' ic-worker || true)"
      echo "Worker readiness attempt=$attempt status=$status"
      if [[ "$status" == healthy ]]; then healthy=1; break; fi
      sleep 2
    done
    [[ "$healthy" == 1 ]]
    python3 - "$bt" "$revision" <<'PY'
import hashlib,json,pathlib,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
state=json.loads((bt/'state.json').read_text());result={'revision':revision,'services':{}}
for service,item in state.items():
    live=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    assert sorted(live['Config']['Env'])==sorted(item['env']),service+' environment mismatch'
    assert live['HostConfig']['PortBindings']==item['ports'] and live['Mounts']==item['mounts'] and live['Config']['Cmd']==item['cmd'],service+' topology mismatch'
    if service!='worker':
        assert live['Image']==item['image'] and live['State']['StartedAt']==item['startedAt'],service+' was unexpectedly replaced'
    else:
        image=json.loads(subprocess.check_output(['docker','image','inspect',live['Image']]))[0]
        assert image['Config']['Labels']['org.opencontainers.image.revision']==revision
        assert live['State']['Health']['Status']=='healthy'
    result['services'][service]={'image':live['Image'],'environmentPreserved':True,'replaced':service=='worker'}
for rel in ['apps/worker/src/reporting/report-jobs.ts','apps/worker/src/reporting/render-png.ts','apps/worker/src/reporting/svg-raster-size.ts']:
    actual=subprocess.check_output(['docker','exec','ic-worker','sha256sum','/app/'+rel]).decode().split()[0]
    assert actual==hashlib.sha256((bt.parent.parent/rel).read_bytes()).hexdigest(),'Worker source mismatch: '+rel
sample=json.loads((bt/'linux-samples.json').read_text())
assert sample['platform']=='linux'
expected={'company':[1080,1520],'personal':[1080,1538],'daily':[1080,1520]}
assert len(sample['results'])==3
for item in sample['results']:
    assert item['decodedSize']==expected[item['kind']]
    assert [item['width'],item['height']]==expected[item['kind']]
    assert item['matchesHighResolutionReference'] and item['syntheticData']
result['linuxSamples']=sample
result['manualTestMessagesSent']=0
(bt/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
PY
    git -C "$repo" merge --ff-only "$revision"
    [[ "$(git -C "$repo" rev-parse HEAD)" == "$revision" ]]
    printf '%s\n' "$release" > /root/docker/qianliu-current-worker-release.txt
    trap - ERR
    echo "COMPLETE revision=$revision release=$release"
    ;;
esac
