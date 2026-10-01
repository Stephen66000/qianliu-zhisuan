#!/usr/bin/env bash
# Unify the four existing BaoTa application services; never run database migrations.
set -Eeuo pipefail
umask 077
mode="${1:---check-contract}"
if [[ "$mode" == --check-contract ]]; then bash -n "$0"; exit 0; fi
revision="${2:?Provide the approved full commit SHA}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
case "$mode" in --prepare|--build|--deploy|--verify|--rollback) ;; *) exit 2;; esac
repo=/root/docker/qianliu-zhisuan
base=/root/docker/qianliu-zhisuan-release-cffa89c/deploy/bt
release="/root/docker/qianliu-unified-${revision:0:12}"
bt="$release/deploy/bt"
state="$bt/release-state.json"
exec 9>/root/docker/.qianliu-unify-release.lock
flock -n 9 || { echo 'Another unified release command is running'; exit 2; }

db_head() {
  docker exec ic-postgres sh -c 'psql -X -Atq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1"'
}
require_db() {
  [[ "$(db_head)" == 0085_historical_usage_not_migrated ]] || {
    echo 'Production migration head changed; stop before application replacement'; exit 2;
  }
}
compose() { docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/runtime.json" "$@"; }
rollback() {
  docker compose --project-directory "$bt" -f "$bt/compose.yaml" -f "$bt/rollback.json" \
    up -d --no-deps --no-build --force-recreate control-api gateway worker web
  echo 'ROLLBACK: previous four application images and their effective environment restored'
}
health() {
  local try
  for try in $(seq 1 30); do
    if [[ "$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9092/health)" == 200 ]] \
      && [[ "$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9093/health)" == 200 ]] \
      && [[ "$(curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9091/)" == 200 ]] \
      && [[ "$(docker inspect --format '{{.State.Health.Status}}' ic-worker)" == healthy ]]; then return 0; fi
    sleep 2
  done
  return 1
}
verify() {
  require_db
  health
  python3 - "$bt" "$revision" <<'PY'
import hashlib,json,pathlib,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
baseline=json.loads((bt/'release-state.json').read_text())
expected=json.loads((bt.parent.parent/'V4/Evidence/MAIN-PRODUCTION-UNIFY-20261001/runtime-expectations.json').read_text())
result={'revision':revision,'services':{},'migration':'0085_historical_usage_not_migrated'}
for service in ['control-api','gateway','worker','web']:
    live=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    image=json.loads(subprocess.check_output(['docker','image','inspect',live['Image']]))[0]
    assert image['Config']['Labels']['org.opencontainers.image.revision']==revision,service+' revision mismatch'
    assert sorted(live['Config']['Env'])==sorted(baseline[service]['env']),service+' environment changed'
    assert live['HostConfig']['PortBindings']==baseline[service]['ports'],service+' ports changed'
    assert live['Mounts']==baseline[service]['mounts'],service+' mounts changed'
    assert live['Config']['Cmd']==baseline[service]['command'],service+' command changed'
    entry={'image_id':live['Image'],'revision':revision,'environment_preserved':True,'ports_preserved':True}
    if service!='web':
        script='''const f=require("fs"),h=require("crypto");const rs=["apps/"+process.argv[1]+"/src",...f.readdirSync("packages").map(p=>"packages/"+p+"/src")].filter(p=>f.existsSync(p));const ps=rs.flatMap(r=>f.readdirSync(r,{recursive:true}).map(p=>r+"/"+p)).filter(p=>/\\.tsx?$/.test(p)&&!p.split("/").some(x=>x.startsWith("._"))).sort();const m=ps.map(p=>h.createHash("sha256").update(f.readFileSync(p)).digest("hex")+"  "+p+"\\n").join("");console.log(JSON.stringify({files:ps.length,sha256:h.createHash("sha256").update(m).digest("hex")}));'''
        actual=json.loads(subprocess.check_output(['docker','exec','ic-'+service,'node','-e',script,service]))
        assert actual==expected[service],service+' source fingerprint mismatch'
        entry['source']=actual
    result['services'][service]=entry
public=subprocess.check_output(['curl','--connect-timeout','5','--max-time','15','-fsS','https://ic-home.qianliuai.com/'])
container=subprocess.check_output(['docker','exec','ic-web','cat','/usr/share/nginx/html/index.html'])
assert public==container,'Public frontend does not match the running Web image'
result['public_frontend_sha256']=hashlib.sha256(public).hexdigest()
subprocess.check_call(['curl','--connect-timeout','5','--max-time','15','-fsS','https://ic-gw.qianliuai.com/health'],stdout=subprocess.DEVNULL)
anonymous=subprocess.check_output(['curl','--connect-timeout','5','--max-time','15','-s','-o','/dev/null','-w','%{http_code}','https://ic-gw.qianliuai.com/v1/models']).decode()
assert anonymous=='401','Gateway anonymous authentication boundary changed'
(bt/'verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
PY
}

case "$mode" in
  --prepare)
    require_db
    [[ -z "$(git -C "$repo" status --porcelain -uno)" ]] || { echo 'Server source has tracked modifications'; exit 2; }
    GIT_TERMINAL_PROMPT=0 git -C "$repo" fetch origin main
    [[ "$(git -C "$repo" rev-parse origin/main)" == "$revision" ]] || { echo 'GitHub main does not match approved revision'; exit 2; }
    [[ ! -e "$release" ]] || { echo 'Release directory already exists; inspect it before reuse'; exit 2; }
    stage="${release}.preparing-$$"
    mkdir "$stage"
    git -C "$repo" archive "$revision" | tar -x -C "$stage"
    mkdir -p "$stage/deploy/bt"
    cp "$base/compose.yaml" "$stage/deploy/bt/compose.yaml"
    cp "$base/.env" "$stage/deploy/bt/.env"
    chmod 600 "$stage/deploy/bt/.env"
    mv "$stage" "$release"
    python3 - "$bt" "$revision" <<'PY'
import json,pathlib,re,subprocess,sys
bt=pathlib.Path(sys.argv[1]);revision=sys.argv[2]
pins=json.loads((bt.parent.parent/'V4/Evidence/MAIN-PRODUCTION-UNIFY-20261001/original-images.json').read_text())
# Use each container's actual environment, so an old common .env cannot reintroduce
# removed model timeout overrides or leak application-only values into the Web service.
template=(bt/'compose.yaml').read_text()
template,count=re.subn(r'(?m)^\s+env_file:\s*\.env\s*\n','',template)
assert count==4,'Unexpected Compose env_file layout; review before continuing'
(bt/'compose.yaml').write_text(template)
runtime={'services':{}};old={'services':{}};state={}
for service in ['control-api','gateway','worker','web']:
    item=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    assert item['Image']==pins[service],service+' changed since source extraction; revalidate before deployment'
    image=item['Image'];tag='ic-'+service+':rollback-main-unify-'+revision[:12]
    subprocess.check_call(['docker','tag',image,tag])
    env=dict(v.split('=',1) for v in item['Config']['Env'])
    # Compose interprets dollar signs in YAML; escape them to preserve literal credentials.
    overrides={k:v.replace('$','$$') for k,v in env.items()}
    runtime['services'][service]={'image':'ic-'+service+':main-'+revision[:12],
        'environment':overrides,'labels':{'io.qianliu.source.revision':revision},
        'build':{'args':{'SOURCE_REVISION':revision}}}
    old['services'][service]={'image':tag,'environment':overrides}
    state[service]={'image_id':image,'env':item['Config']['Env'],'ports':item['HostConfig']['PortBindings'],
        'mounts':item['Mounts'],'command':item['Config']['Cmd'],'previous_working_dir':item['Config']['Labels'].get('com.docker.compose.project.working_dir')}
for name,data in [('runtime.json',runtime),('rollback.json',old),('release-state.json',state)]:
    (bt/name).write_text(json.dumps(data,indent=2)+'\n')
print('Prepared isolated release; previous images, effective environment, ports and mounts recorded')
PY
    compose config --quiet
    printf 'PREPARED revision=%s release=%s\n' "$revision" "$release"
    ;;
  --build)
    [[ -f "$state" ]] || exit 2
    compose build control-api gateway worker web
    for service in control-api gateway worker web; do
      [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-$service:main-${revision:0:12}")" == "$revision" ]] || exit 2
    done
    echo 'BUILD_PASS: four images bind to the approved revision'
    ;;
  --deploy)
    require_db
    python3 - "$state" <<'PY'
import json,subprocess,sys
state=json.load(open(sys.argv[1]))
for service,item in state.items():
    live=json.loads(subprocess.check_output(['docker','inspect','ic-'+service]))[0]
    assert live['Image']==item['image_id'],service+' changed since prepare'
    assert live['Config']['Env']==item['env'],service+' configuration changed since prepare'
PY
    for service in control-api gateway worker web; do
      [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "ic-$service:main-${revision:0:12}")" == "$revision" ]] || exit 2
    done
    # Wait for existing gateway connections before replacing its image.
    for attempt in $(seq 1 120); do
      connections="$(ss -Htn state established '( sport = :9093 )' | awk 'END { print NR }')"
      [[ "$connections" == 0 ]] && break
      echo "Waiting for $connections existing Gateway connection(s)"
      sleep 5
    done
    [[ "$connections" == 0 ]] || { echo 'Gateway drain did not complete; no service replaced'; exit 2; }
    restore_on_failure() { local rc=$?; trap - ERR; rollback || true; exit "$rc"; }
    trap restore_on_failure ERR
    compose up -d --no-deps --no-build --force-recreate control-api gateway worker web
    verify
    [[ -z "$(git -C "$repo" status --porcelain -uno)" ]]
    if git -C "$repo" show-ref --verify --quiet refs/heads/main; then
      git -C "$repo" switch main
    else git -C "$repo" switch -c main origin/main; fi
    git -C "$repo" merge --ff-only "$revision"
    [[ "$(git -C "$repo" rev-parse HEAD)" == "$revision" ]]
    printf '%s\n' "$release" > /root/docker/qianliu-current-unified-release.txt
    trap - ERR
    printf 'COMPLETE revision=%s release=%s\n' "$revision" "$release"
    ;;
  --verify) verify; ;;
  --rollback) rollback; ;;
esac
