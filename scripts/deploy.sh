#!/usr/bin/env bash
set -euo pipefail

# Single entry point: provision Quick Order's OWN EC2 (via infra-up.sh),
# point it at the dashboard's deployed backend, and deploy the app there.
# Deliberately a SEPARATE instance/VPC/IP from the dashboard's own infra.
# AWS-only: no local-mode fallback. Every failure either aborts with the exact
# fix command, or requires an explicit, deliberate opt-in to continue anyway.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="$(cd "$ROOT_DIR/../typescript-implementations" && pwd)"

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
echo "[2/4] Provisioning Quick Order's own infra (EC2 + VPC)..."
if ! "$ROOT_DIR/scripts/infra-up.sh"; then
  echo "  Infra provisioning failed. Fix the error above, then rerun: ./scripts/deploy.sh"
  exit 1
fi

EC2_IP=$(cd "$ROOT_DIR/infra" && terraform output -raw ec2_public_ip 2>/dev/null || true)
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
DASHBOARD_IP=$(cd "$DASHBOARD_DIR/infra" && terraform output -raw ec2_public_ip 2>/dev/null || true)
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
ssh $SSH_OPTS "ec2-user@${EC2_IP}" "command -v rsync >/dev/null 2>&1 || sudo dnf install -y rsync"
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

CDN_URL="$(cd "$ROOT_DIR/infra" && terraform output -raw cdn_url 2>/dev/null || true)"

echo ""
echo "✓ Quick Order live at   ${CDN_URL:-http://${EC2_IP} (CloudFront URL unavailable, HTTP only)}"
echo "  Direct (HTTP):        http://${EC2_IP}"
echo "  SSH:                  ssh -i ${SSH_KEY} ec2-user@${EC2_IP}"
echo "  Tear down:            ./scripts/infra-down.sh"
