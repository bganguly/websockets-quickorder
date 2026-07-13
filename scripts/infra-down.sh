#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

_ws_resource_count() {
  local ws="$1" sf
  sf="$INFRA_DIR/terraform.tfstate.d/$ws/terraform.tfstate"
  [[ -f "$sf" ]] || { echo 0; return; }
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(sum(1 for r in d.get('resources',[]) if r.get('mode')=='managed'))
except Exception:
    print(0)
" "$sf" 2>/dev/null || echo 0
}

_ws_instance_type() {
  local ws="$1" sf
  sf="$INFRA_DIR/terraform.tfstate.d/$ws/terraform.tfstate"
  [[ -f "$sf" ]] || return 0
  python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for r in d.get('resources', []):
        if r.get('type') == 'aws_instance':
            for i in r.get('instances', []):
                t = i.get('attributes', {}).get('instance_type', '')
                if t:
                    print(t)
                    sys.exit(0)
except Exception:
    pass
" "$sf" 2>/dev/null || true
}

_local_running=0
lsof -ti:3005 >/dev/null 2>&1 && _local_running=1 || true
_lite_count=$(_ws_resource_count lite)
_full_count=$(_ws_resource_count full)
_lite_type=$(_ws_instance_type lite)
_full_type=$(_ws_instance_type full)

_CHAINED=0
if [[ -n "${DEPLOY_MODE:-}" ]]; then
  case "$DEPLOY_MODE" in
    lite) NAME_PREFIX="quickorder-lite" ;;
    full) NAME_PREFIX="quickorder" ;;
    *) printf 'Invalid DEPLOY_MODE "%s" — must be lite or full.\n' "$DEPLOY_MODE"; exit 1 ;;
  esac
  _CHAINED=1
  printf '\n=== websockets-quickorder teardown (chained, mode: %s) ===\n' "$DEPLOY_MODE"
else
  printf '\n=== websockets-quickorder teardown ===\n\n'
  printf '  [1] Local  — stop local dev server'
  (( _local_running )) && printf ' [running]' || printf ' [not detected]'
  printf '\n'
  printf '  [2] Lite   — destroy AWS EC2 t3.small'
  (( _lite_count > 0 )) && printf ' [%s resources active: %s]' "$_lite_count" "${_lite_type:-?}" || printf ' [not deployed]'
  printf '\n'
  printf '  [3] Full   — destroy AWS EC2 t3.medium'
  (( _full_count > 0 )) && printf ' [%s resources active: %s]' "$_full_count" "${_full_type:-?}" || printf ' [not deployed]'
  printf '\n'
  printf '\nChoice [1/2/3]: '
  read -r _MODE

  case "$_MODE" in
    1)
      printf '\nStopping local Quick Order process on :3005...\n'
      if lsof -ti:3005 >/dev/null 2>&1; then
        kill "$(lsof -ti:3005)" 2>/dev/null || true
        printf 'Stopped.\n'
      else
        printf 'Nothing running on :3005.\n'
      fi
      exit 0
      ;;
    2) DEPLOY_MODE="lite"; NAME_PREFIX="quickorder-lite" ;;
    3) DEPLOY_MODE="full"; NAME_PREFIX="quickorder"      ;;
    *) printf 'No valid choice — exiting.\n'; exit 0 ;;
  esac
fi

if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
  for _candidate in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub ~/.ssh/id_ecdsa.pub; do
    if [[ -f "$(eval echo "$_candidate")" ]]; then
      export TF_VAR_ssh_public_key_path="$_candidate"
      break
    fi
  done
  if [[ -z "${TF_VAR_ssh_public_key_path:-}" ]]; then
    printf 'No SSH public key found; creating a temporary one for destroy.\n'
    _tmp_key="$(mktemp)"
    ssh-keygen -t ed25519 -N "" -f "$_tmp_key" -q
    export TF_VAR_ssh_public_key_path="${_tmp_key}.pub"
    _cleanup_tmp_key=1
  fi
fi

export TF_VAR_name_prefix="$NAME_PREFIX"

cd "$INFRA_DIR"
terraform init -input=false

if ! terraform workspace select "$DEPLOY_MODE" 2>/dev/null; then
  printf 'No "%s" workspace found — nothing to destroy.\n' "$DEPLOY_MODE"
  exit 0
fi

AWS_REGION=$(aws configure get region 2>/dev/null || printf 'us-east-1')
_instance_type=$([[ "$DEPLOY_MODE" == "full" ]] && printf 't3.medium' || printf 't3.small')
printf '\nThis will destroy the Quick Order %s resources in region %s.\n' "$DEPLOY_MODE" "$AWS_REGION"
printf 'Removes: EC2 (%s), EIP, VPC, security group, CloudFront distribution.\n' "$_instance_type"
if (( _CHAINED == 0 )); then
  printf '\nProceed? [Y/n] '
  read -r yn
  [[ -z "$yn" || "$yn" =~ ^[Yy]$ ]] || { printf 'Aborted.\n'; exit 0; }
fi

terraform destroy -auto-approve
[[ -n "${_cleanup_tmp_key:-}" ]] && rm -f "$_tmp_key" "${_tmp_key}.pub" || true
printf '\nQuick Order %s infra destroyed (billing stopped).\n' "$DEPLOY_MODE"
