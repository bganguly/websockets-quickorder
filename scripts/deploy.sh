#!/usr/bin/env bash
set -euo pipefail

# Single entry point: local dev or provision Quick Order's OWN EC2 (via infra-up.sh),
# point it at the dashboard's deployed backend, and deploy the app there.
# Deliberately a SEPARATE instance/VPC/IP from the dashboard's own infra.
# AWS-only remote modes. Every failure either aborts with the exact
# fix command, or requires an explicit, deliberate opt-in to continue anyway.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="$(cd "$ROOT_DIR/../nextjs-dashboard" && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

# ── helpers ───────────────────────────────────────────────────────────────────
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

# ── detect current state ──────────────────────────────────────────────────────
_local_running=0
lsof -ti:3005 >/dev/null 2>&1 && _local_running=1 || true
_lite_count=$(_ws_resource_count lite)
_full_count=$(_ws_resource_count full)
_lite_type=$(_ws_instance_type lite)
_full_type=$(_ws_instance_type full)

# ── mode menu ─────────────────────────────────────────────────────────────────
if [[ -n "${DEPLOY_MODE:-}" ]]; then
  case "$DEPLOY_MODE" in
    local) _TARGET="local" ;;
    lite)  _TARGET="remote"; INSTANCE_TYPE="t3.small";  NAME_PREFIX="quickorder-lite" ;;
    full)  _TARGET="remote"; INSTANCE_TYPE="t3.medium"; NAME_PREFIX="quickorder"      ;;
    *)     printf 'Invalid DEPLOY_MODE "%s" — must be local, lite, or full.\n' "$DEPLOY_MODE"; exit 1 ;;
  esac
  printf '\n=== websockets-quickorder (chained, mode: %s) ===\n' "$DEPLOY_MODE"
else
  printf '\n=== websockets-quickorder ===\n\n'
  printf '  [1] Local  — Next.js dev server on localhost:3005 (no AWS cost)'
  (( _local_running )) && printf ' [running]' || printf ' [not detected]'
  printf '\n'
  printf '  [2] Lite   — AWS: EC2 t3.small (cost-effective demo)'
  (( _lite_count > 0 )) && printf ' [%s resources active: %s]' "$_lite_count" "${_lite_type:-?}" || printf ' [not deployed]'
  printf '\n'
  printf '  [3] Full   — AWS: EC2 t3.medium (more RAM, no swap dependency)'
  (( _full_count > 0 )) && printf ' [%s resources active: %s]' "$_full_count" "${_full_type:-?}" || printf ' [not deployed]'
  printf '\n'
  printf '\nChoice [1/2/3]: '
  read -r _MODE
  case "$_MODE" in
    2) _TARGET="remote"; DEPLOY_MODE="lite"; INSTANCE_TYPE="t3.small";  NAME_PREFIX="quickorder-lite" ;;
    3) _TARGET="remote"; DEPLOY_MODE="full"; INSTANCE_TYPE="t3.medium"; NAME_PREFIX="quickorder"      ;;
    *) _TARGET="local";  DEPLOY_MODE="";    INSTANCE_TYPE="";           NAME_PREFIX=""                ;;
  esac
fi

# ══════════════════════════════════════════════════════════════════════════════
# LOCAL
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$_TARGET" == "local" ]]; then
  BACKEND_URL="${BACKEND_URL:-http://localhost:3004}"
  printf '\nInstalling deps...\n'
  cd "$ROOT_DIR"
  npm install --prefer-offline 2>/dev/null || npm install
  printf '\nStarting Quick Order dev server on :3005 (BACKEND_URL=%s)...\n' "$BACKEND_URL"
  printf 'Override: BACKEND_URL=http://other-host:port ./scripts/deploy.sh\n\n'
  BACKEND_URL="$BACKEND_URL" npm run dev
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# REMOTE (AWS)
# ══════════════════════════════════════════════════════════════════════════════

# ── 1. Check AWS credentials ──────────────────────────────────────────────────
echo ""
echo "[1/4] Checking AWS credentials..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "  AWS credentials not found or invalid. Configure them (aws configure) and rerun."
  exit 1
fi
echo "  Credentials valid."

# ── 2. Provision this app's OWN EC2 (separate from the dashboard's) ─────────
echo ""
echo "[2/4] Provisioning Quick Order's own infra (${DEPLOY_MODE}: EC2 ${INSTANCE_TYPE} + VPC)..."
export TF_VAR_ec2_instance_type="$INSTANCE_TYPE"
export TF_VAR_name_prefix="$NAME_PREFIX"

cd "$INFRA_DIR"
terraform init -input=false
terraform workspace select "$DEPLOY_MODE" 2>/dev/null || terraform workspace new "$DEPLOY_MODE"
cd "$ROOT_DIR"

if ! "$ROOT_DIR/scripts/infra-up.sh"; then
  echo "  Infra provisioning failed. Fix the error above, then rerun: ./scripts/deploy.sh"
  exit 1
fi

EC2_IP=$(cd "$INFRA_DIR" && terraform output -raw ec2_public_ip 2>/dev/null || true)
if [[ -z "$EC2_IP" ]]; then
  echo "  EC2 public IP not found in Terraform outputs. Rerun: ./scripts/deploy.sh"
  exit 1
fi

# ── 3. Resolve the dashboard's deployed backend URL ─────────────────────────
# Read the DASHBOARD's own Terraform output rather than hardcoding an IP, so
# this keeps working across the dashboard's own redeploys/IP changes. Its
# Nginx already proxies :80 -> :3004, so plain http://<ip> is the right URL
# (this call is server-to-server inside Next.js rewrites, not the browser —
# no mixed-content/HTTPS concern here, unlike the dashboard's own link to us).
#
# Unlike the dashboard (which degrades gracefully with an in-app "Quick Order
# isn't running" banner when we're not deployed yet), Quick Order has NO
# working feature at all without a real backend — every API call would fail.
# So if the dashboard hasn't been deployed (out-of-order run), this must
# either abort with the exact fix command, or be an explicit, deliberate
# opt-in to deploy anyway — never a silent localhost fallback baked into an
# EC2 build, which would look "successful" while being completely broken.
_get_dashboard_ip() {
  local dir="$1"
  local ip
  for ws in lite full default; do
    if [[ "$ws" == "default" ]]; then
      ip=$(cd "$dir" && terraform output -raw ec2_public_ip 2>/dev/null || true)
    else
      ip=$(cd "$dir" && terraform workspace select "$ws" >/dev/null 2>&1 && terraform output -raw ec2_public_ip 2>/dev/null || true)
    fi
    [[ -n "$ip" ]] && echo "$ip" && return
  done
}
if [[ -n "${BACKEND_URL:-}" ]]; then
  echo "  Backend (dashboard) URL (chained): $BACKEND_URL"
else
  DASHBOARD_IP=$(_get_dashboard_ip "$DASHBOARD_DIR/infra")
  if [[ -n "$DASHBOARD_IP" ]] && curl -fsS --max-time 3 "http://${DASHBOARD_IP}" >/dev/null 2>&1; then
    BACKEND_URL="http://${DASHBOARD_IP}"
    echo "  Backend (dashboard) URL: $BACKEND_URL"
  else
    echo ""
    if [[ -z "$DASHBOARD_IP" ]]; then
      echo "  Dashboard backend not found — its Terraform infra hasn't been provisioned yet."
    else
      echo "  Dashboard infra exists at ${DASHBOARD_IP}, but it isn't responding — the app"
      echo "  itself may not be deployed there yet (deploy.sh not yet run to completion)."
    fi
    echo "  Deploy it first:"
    echo "    cd ${DASHBOARD_DIR} && ./scripts/deploy.sh"
    echo ""
    printf "  Deploy Quick Order to EC2 anyway, pointed at BACKEND_URL=http://localhost:3004 (will NOT work)? [y/N] "
    read -r yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      BACKEND_URL="http://localhost:3004"
      echo "  Proceeding with a known-broken BACKEND_URL by explicit choice."
    else
      echo "Aborted. Deploy the dashboard first, then rerun this script."
      exit 1
    fi
  fi
fi

# Detect SSH private key matching the public key passed to Terraform.
SSH_KEY=""
for candidate in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
  [[ -f "$candidate" ]] && { SSH_KEY="$candidate"; break; }
done
if [[ -z "$SSH_KEY" ]]; then
  SSH_KEY=$(ls "$HOME/.ssh/"*.pub 2>/dev/null | head -1 | sed 's/\.pub$//' || true)
fi
if [[ -z "$SSH_KEY" || ! -f "$SSH_KEY" ]]; then
  echo "  No SSH private key found in ~/.ssh/. Generate one with: ssh-keygen -t ed25519"
  exit 1
fi
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -i $SSH_KEY"

if ! ssh-add -l 2>/dev/null | grep -qF "$SSH_KEY"; then
  ssh-add "$SSH_KEY" || { echo "  ssh-add failed. Ensure ssh-agent is running or the key is unencrypted."; exit 1; }
fi

# ── 4. Deploy to Quick Order's own EC2 ───────────────────────────────────────
echo ""
echo "[4/4] Deploying to EC2 at ${EC2_IP}..."

echo "  Waiting for EC2 SSH to become available..."
for i in $(seq 1 36); do
  if ssh $SSH_OPTS "ec2-user@${EC2_IP}" true 2>/dev/null; then
    echo "  SSH ready."
    break
  fi
  [[ $i -eq 36 ]] && { echo "  SSH did not become available after 3 min. Check EC2 status."; exit 1; }
  sleep 5
done

echo "  Syncing app files..."
ssh $SSH_OPTS "ec2-user@${EC2_IP}" "command -v rsync >/dev/null 2>&1 || sudo dnf install -y rsync; sudo mkdir -p /app && sudo chown ec2-user:ec2-user /app"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env*' \
  --exclude='infra' \
  -e "ssh $SSH_OPTS" \
  "$ROOT_DIR/" "ec2-user@${EC2_IP}:/app/"

echo "  Building and starting Quick Order on EC2..."
ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
  set -e
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    sudo npm install -g pm2
  fi
  cd /app
  export BACKEND_URL='${BACKEND_URL}'
  npm ci --prefer-offline
  npm run build
  pm2 stop quickorder 2>/dev/null || true
  BACKEND_URL='${BACKEND_URL}' pm2 start "npm run start" --name quickorder
  pm2 save

  command -v nginx >/dev/null 2>&1 || sudo dnf install -y nginx
  sudo tee /etc/nginx/conf.d/app.conf > /dev/null <<'NGINX_CONF'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_CONF
  sudo rm -f /etc/nginx/conf.d/default.conf
  sudo nginx -t
  sudo systemctl enable nginx
  sudo systemctl restart nginx
REMOTE

CDN_URL="$(cd "$INFRA_DIR" && terraform output -raw cdn_url 2>/dev/null || true)"

echo ""
echo "✓ Quick Order live at   ${CDN_URL:-http://${EC2_IP} (CloudFront URL unavailable, HTTP only)}"
echo "  Direct (HTTP):        http://${EC2_IP}"
echo "  SSH:                  ssh -i ${SSH_KEY} ec2-user@${EC2_IP}"
echo "  Tear down:            ./scripts/infra-down.sh"
