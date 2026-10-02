#!/usr/bin/env bash
# Replace only Control API and Web for the archive/opening-alert fix.
set -Eeuo pipefail
umask 077
mode="${1:---check-contract}"
if [[ "$mode" == --check-contract ]]; then bash -n "$0"; exit 0; fi
revision="${2:?Full revision required}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
case "$mode" in --prepare|--build|--deploy|--verify) ;; *) exit 2;; esac
repo=/root/docker/qianliu-zhisuan
release="/root/docker/qianliu-home-opening-${revision:0:12}"
bt="$release/deploy/bt"
exec 9>/root/docker/.qianliu-unify-release.lock
flock -n 9 || { echo 'Another release is running'; exit 2; }
compose() { docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/runtime.json" -f "$bt/home.json" "$@"; }
check_baseline() {
  python3 - "$bt" <<'PY'
import json,pathlib,subprocess,sys
state=json.loads((pathlib.Path(sys.argv[1])/'home-state.json').read_text())
for service,item in state.items():
    live=json.loads(subprocess.check_output(['docker','inspect',service]))[0]
    assert live['Image']==item['image'] and sorted(live['Config']['Env'])==sorted(item['env']),service+' baseline changed'
    assert live['State']['StartedAt']==item['startedAt'],service+' restarted since prepare'
PY
}
verify() {
  python3 - "$bt" "$revision" <<'PY'
import hashlib,json,pathlib,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
state=json.loads((bt/'home-state.json').read_text());result={'revision':revision,'services':{}}
for service,item in state.items():
    live=json.loads(subprocess.check_output(['docker','inspect',service]))[0]
    assert sorted(live['Config']['Env'])==sorted(item['env']),service+' environment changed'
    assert live['HostConfig']['PortBindings']==item['ports'] and live['Mounts']==item['mounts'] and live['Config']['Cmd']==item['cmd'],service+' topology changed'
    replaced=service in ['ic-control-api','ic-web']
    if replaced:
        image=json.loads(subprocess.check_output(['docker','image','inspect',live['Image']]))[0]
        assert image['Config']['Labels']['org.opencontainers.image.revision']==revision,service+' wrong revision'
        assert live['State']['Running'],service+' not running'
    else:
        assert live['Image']==item['image'] and live['State']['StartedAt']==item['startedAt'],service+' unexpectedly replaced'
    result['services'][service]={'image':live['Image'],'replaced':replaced,'configurationPreserved':True}
rel='packages/database/src/repositories/dashboard-home-providers.ts'
actual=subprocess.check_output(['docker','exec','ic-control-api','sha256sum','/app/'+rel]).decode().split()[0]
assert actual==hashlib.sha256((bt.parent.parent/rel).read_bytes()).hexdigest(),'homepage source mismatch'
public=subprocess.check_output(['curl','--connect-timeout','5','--max-time','15','-fsS','https://ic-home.qianliuai.com/'])
container=subprocess.check_output(['docker','exec','ic-web','cat','/usr/share/nginx/html/index.html'])
assert public==container,'public Web does not match container'
result['publicFrontendSha256']=hashlib.sha256(public).hexdigest()
(bt/'home-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
PY
}
case "$mode" in
  --prepare)
    [[ -z "$(git -C "$repo" status --porcelain -uno)" ]] || exit 2
    GIT_TERMINAL_PROMPT=0 git -C "$repo" fetch origin main
    [[ "$(git -C "$repo" rev-parse origin/main)" == "$revision" ]] || exit 2
    [[ ! -e "$release" ]] || { echo 'Release exists; inspect before reuse'; exit 2; }
    base="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ic-control-api)"
    case "$base" in /root/docker/qianliu-*/deploy/bt) ;; *) exit 2;; esac
    mkdir "$release"
    git -C "$repo" archive "$revision" | tar -x -C "$release"
    mkdir -p "$bt"
    cp "$base/compose.yaml" "$base/runtime.json" "$base/.env" "$bt/"
    python3 - "$bt" "$revision" <<'PY'
import json,pathlib,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
state={};overrides={};rollback={}
for service in ['control-api','gateway','worker','web','postgres','redis']:
    name='ic-'+service
    live=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    state[name]={'image':live['Image'],'env':live['Config']['Env'],'ports':live['HostConfig']['PortBindings'],
        'mounts':live['Mounts'],'cmd':live['Config']['Cmd'],'startedAt':live['State']['StartedAt']}
    if service in ['control-api','web']:
        tag=name+':rollback-home-'+revision[:12]
        subprocess.check_call(['docker','tag',live['Image'],tag])
        overrides[service]={'image':name+':home-'+revision[:12],
          'build':{'args':{'SOURCE_REVISION':revision}},'labels':{'io.qianliu.source.revision':revision}}
        rollback[service]={'image':tag}
for name,data in [('home-state.json',state),('home.json',{'services':overrides}),('home-rollback.json',{'services':rollback})]:
    (bt/name).write_text(json.dumps(data,indent=2)+'\n')
print('Rollback images and existing service configuration recorded')
PY
    compose config --quiet
    echo PREPARED
    ;;
  --build)
    compose build control-api web
    for service in control-api web; do
      [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-$service:home-${revision:0:12}")" == "$revision" ]]
    done
    echo BUILD_PASS
    ;;
  --deploy)
    check_baseline
    for service in control-api web; do
      [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-$service:home-${revision:0:12}")" == "$revision" ]]
    done
    rollback() {
      docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/runtime.json" -f "$bt/home-rollback.json" \
        up -d --no-deps --no-build --force-recreate control-api web
      echo ROLLED_BACK
    }
    on_error() { local rc=$?; trap - ERR; rollback || true; exit "$rc"; }
    trap on_error ERR
    compose up -d --no-deps --no-build --force-recreate control-api web
    ready=0
    for attempt in $(seq 1 30); do
      api="$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9092/health || true)"
      web="$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9091/ || true)"
      echo "READINESS attempt=$attempt api=$api web=$web"
      if [[ "$api/$web" == 200/200 ]]; then ready=1; break; fi
      sleep 2
    done
    [[ "$ready" == 1 ]]
    verify
    git -C "$repo" merge --ff-only "$revision"
    trap - ERR
    echo DEPLOY_PASS
    ;;
  --verify) verify ;;
esac
