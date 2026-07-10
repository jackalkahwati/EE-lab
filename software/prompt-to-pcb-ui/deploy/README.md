# Deploying Compose to the Oracle VM (app.firstlight.build)

Compose is filesystem-backed (accounts, run artifacts, enterprise store), so it
runs as a long-lived Next server on the Oracle VM (persistent disk) behind a
reverse proxy — **not** on Vercel serverless. See `../../../docs/deployment.md`
for the big picture.

Target: `oracle-work-hub` (147.224.63.79, user `ubuntu`). Serves loopback
`127.0.0.1:4500`; the proxy terminates TLS for `app.firstlight.build`.

## One-time setup (on the VM)

```bash
# 1. Get the code onto the VM (persistent disk, e.g. ~/EE-lab)
cd ~ && git clone <repo-url> EE-lab      # or copy the branch over
cd ~/EE-lab/software/prompt-to-pcb-ui

# 2. Secrets/config (never committed)
sudo cp deploy/env.example /etc/firstlight-compose.env
sudo nano /etc/firstlight-compose.env    # fill in AUTH_SECRET + keys
sudo chmod 600 /etc/firstlight-compose.env

# 3. systemd service
sudo cp deploy/firstlight-compose.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable firstlight-compose

# 4. Reverse proxy — pick the one already installed on the VM:
#    Caddy (auto-TLS):
sudo sh -c 'cat /home/ubuntu/EE-lab/software/prompt-to-pcb-ui/deploy/Caddyfile.snippet >> /etc/caddy/Caddyfile'
sudo systemctl reload caddy
#    ...OR nginx + certbot: see deploy/nginx-app.firstlight.build.conf

# 5. First build + start
./deploy/deploy.sh
```

## DNS
`app.firstlight.build` → A record → `147.224.63.79` (set in Vercel → Domains).

## Google OAuth
Add to the existing OAuth client:
- redirect URI: `https://app.firstlight.build/api/auth/google/callback`
- JS origin: `https://app.firstlight.build`

## Redeploys
```bash
cd ~/EE-lab/software/prompt-to-pcb-ui && ./deploy/deploy.sh
```

## Ops
- Logs: `journalctl -u firstlight-compose -f`
- Restart: `sudo systemctl restart firstlight-compose`
- Persistent data (back this up): `data/` (users.json, enterprise store) and `public/runs/`
- Firewall: OCI security list must allow 80/443 inbound.

## Note on SSH
If SSH resets/times out at the banner, fail2ban has likely banned the client IP.
Unban from the OCI serial console: `sudo fail2ban-client unban <ip>`, or wait
out the bantime. TCP 22 reachable + banner timeout = ban, not an app problem.
