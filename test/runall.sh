#!/bin/bash
# Full verification: fresh database for each suite
cd "$(dirname "$0")"
roles() { su postgres -c "psql -d hc -q -c \"update profiles set role='counter', branch_code='DXB', active=true where email='counter@hc.test'; update profiles set role='cashier', branch_code='DXB', active=true where email='cashier@hc.test'; update profiles set role='warehouse', branch_code='DXB', active=true where email='warehouse@hc.test'; update profiles set role='operations', branch_code='DXB', active=true where email='ops@hc.test'; update profiles set role='release_officer', branch_code='DAR', active=true where email='release@hc.test'; update profiles set role='accountant', branch_code='DXB', active=true where email='accountant@hc.test'; update profiles set role='finance_manager', branch_code='DAR', active=true where email='finance@hc.test';\"" >/dev/null; }
restart_server() {
  for p in $(pgrep -f "^node server.mjs"); do kill "$p" 2>/dev/null; done
  sleep 0.5
  nohup node server.mjs > /tmp/hc-server.log 2>&1 &
  sleep 1.2
}
for suite in "$@"; do
  ./reset.sh >/dev/null 2>&1; roles; restart_server
  echo "══════════ $suite ══════════"
  node "$suite" 2>&1 | grep -E "✗|ERRORS|Error|error:" -A2 | head -20
  echo "   (finished $suite)"
done
