#!/bin/bash
# One-time Stripe wiring for FirstLight Compose Pro (StarDrive Inc. account).
#
# Prereq: `stripe login` completed (CLI authed to the Stardrive account).
# What it does:
#   1. finds-or-creates the "FirstLight Compose Pro" product + $49/mo price
#   2. writes STRIPE_SECRET_KEY (the CLI's key) + STRIPE_PRICE_ID to .env.local
#   3. prints the production-webhook TODO
#
# Test vs live: pass --live for the live account (default: test mode, so you
# can run a full checkout with card 4242 4242 4242 4242 first).
set -euo pipefail
cd "$(dirname "$0")/.."

MODE_FLAG=""
KEY_FIELD="test_mode_api_key"
if [[ "${1:-}" == "--live" ]]; then
  MODE_FLAG="--live"
  KEY_FIELD="live_mode_api_key"
fi

echo "== checking CLI auth =="
stripe products list --limit 1 $MODE_FLAG > /dev/null

echo "== find-or-create product =="
PRODUCT_ID=$(stripe products list --limit 100 $MODE_FLAG | python3 -c "
import json,sys
for p in json.load(sys.stdin)['data']:
    if p['name'] == 'FirstLight Compose Pro':
        print(p['id']); break")
if [[ -z "$PRODUCT_ID" ]]; then
  PRODUCT_ID=$(stripe products create $MODE_FLAG \
    -d name="FirstLight Compose Pro" \
    -d description="Unlimited board runs, priority pipeline, design reviews included" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "created product $PRODUCT_ID"
else
  echo "found product $PRODUCT_ID"
fi

echo "== find-or-create \$49/mo price =="
PRICE_ID=$(stripe prices list --limit 100 $MODE_FLAG -d product="$PRODUCT_ID" | python3 -c "
import json,sys
for p in json.load(sys.stdin)['data']:
    if p.get('unit_amount') == 4900 and (p.get('recurring') or {}).get('interval') == 'month' and p['active']:
        print(p['id']); break")
if [[ -z "$PRICE_ID" ]]; then
  PRICE_ID=$(stripe prices create $MODE_FLAG \
    -d product="$PRODUCT_ID" \
    -d unit_amount=4900 \
    -d currency=usd \
    -d "recurring[interval]"=month \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "created price $PRICE_ID"
else
  echo "found price $PRICE_ID"
fi

echo "== writing .env.local =="
SECRET=$(python3 -c "
import tomllib, os
cfg = tomllib.load(open(os.path.expanduser('~/.config/stripe/config.toml'), 'rb'))
print(cfg['default']['$KEY_FIELD'])")
# replace any prior stripe lines
grep -v "^STRIPE_SECRET_KEY=\|^STRIPE_PRICE_ID=" .env.local > .env.local.tmp || true
mv .env.local.tmp .env.local
printf 'STRIPE_SECRET_KEY=%s\nSTRIPE_PRICE_ID=%s\n' "$SECRET" "$PRICE_ID" >> .env.local
echo "wrote STRIPE_SECRET_KEY + STRIPE_PRICE_ID ($PRICE_ID)"

echo
echo "done. restart the app: kill the 4500 server and 'npx next start -p 4500'"
echo
echo "PRODUCTION TODO (when deployed to a public URL):"
echo "  stripe webhook endpoints create --url https://<domain>/api/billing/webhook \\"
echo "    --enabled-events checkout.session.completed,customer.subscription.deleted"
echo "  then put the whsec_... into STRIPE_WEBHOOK_SECRET"
echo "  NOTE: CLI keys expire every 90 days — mint a restricted key in the"
echo "  Dashboard (Checkout Sessions: write) for the production server."
