#!/usr/bin/env bash
set -euo pipefail

export EVE_API_URL=http://api.eve.lvh.me

# Ensure test org
ORG_ID=$(eve org ensure "dashboard-test" --slug dashboard-test --json | jq -r '.id')

# Ensure test project
PROJECT_ID=$(eve project ensure --org "$ORG_ID" --name "DashTest" --slug dashtest \
  --repo-url https://github.com/eve-horizon/eve-horizon-starter --json | jq -r '.id')

# Create jobs in various phases for board tests
eve job create --project "$PROJECT_ID" --title "Ready job" --priority 2 --phase ready
eve job create --project "$PROJECT_ID" --title "P0 critical" --priority 0 --phase ready
eve job create --project "$PROJECT_ID" --title "Active job" --priority 1 --phase active
eve job create --project "$PROJECT_ID" --title "Review needed" --priority 2 --phase review
for i in $(seq 1 5); do
  eve job create --project "$PROJECT_ID" --title "Done job $i" --priority 3 --phase done
done

echo "Seed complete: org=$ORG_ID project=$PROJECT_ID"
