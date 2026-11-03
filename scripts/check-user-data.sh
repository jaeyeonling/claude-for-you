#!/usr/bin/env bash
# Render terraform's local.user_data exactly as EC2 receives it and check it.
#
# Why render instead of linting main.tf: the script is an HCL heredoc, so `$${`
# escapes and `%{if}` directives decide what bash actually sees. #180 shipped
# `$${ARCH == "x86_64" && "amd64" || "arm64"}`, an HCL conditional escaped into
# a bash `${…}` that bash rejects at runtime ("bad substitution"). It aborted
# every fresh instance's user_data for five months. Neither `bash -n` nor
# ShellCheck flags it (expansion-time error), so we grep the rendered script.
#
# Renders in a scratch copy with no state and no AWS credentials (env and
# ~/.aws both blocked), so CI and a laptop with live state see the same thing.
# Assumes terraform.tfvars.example is a complete input set.
#
# Needs: terraform, jq. No AWS access. Usage (repo root):
#   bash scripts/check-user-data.sh
# Set TF_PLUGIN_CACHE_DIR to skip re-downloading the AWS provider.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "  ✗ $*" >&2; exit 1; }

for f in terraform/.terraform.lock.hcl terraform/terraform.tfvars.example; do
  [ -f "$f" ] || fail "missing $f"
done
cp terraform/*.tf terraform/.terraform.lock.hcl "$WORK/"
cp terraform/terraform.tfvars.example "$WORK/terraform.tfvars"

# No credentials anywhere: if local.user_data ever starts depending on a data
# source, this fails loudly instead of quietly rendering against a real account.
tf() {
  env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
    terraform -chdir="$WORK" "$@"
}

tf init -backend=false -input=false >"$WORK/init.log" 2>&1 \
  || { cat "$WORK/init.log" >&2; fail "terraform init failed"; }

# No nonsensitive(): if a sensitive value is ever interpolated into user_data,
# terraform refuses to print it here instead of it reaching a public CI log.
echo 'jsonencode(local.user_data)' | tf console >"$WORK/rendered.json" 2>"$WORK/console.err" \
  || { cat "$WORK/console.err" >&2; fail "terraform console failed"; }
jq -er 'fromjson' "$WORK/rendered.json" >"$WORK/user-data.sh" 2>/dev/null \
  || { head -c 500 "$WORK/rendered.json" >&2; cat "$WORK/console.err" >&2; fail "console output is not the rendered string (empty stdin? sensitive value?)"; }
[ -s "$WORK/user-data.sh" ] || fail "rendered user_data is empty"

head -1 "$WORK/user-data.sh" | grep -qx '#!/bin/bash' \
  || fail "first line must be exactly #!/bin/bash (an indented shebang breaks cloud-init scripts-user)"

bash -n "$WORK/user-data.sh" || fail "rendered user_data has a bash syntax error"

# Heuristic: bash parameter expansion has no ==, !=, &&, || or ` ? `, so these
# inside ${…} are almost always an HCL expression that `$${` let through.
# Known false positives: an operator inside a default value, e.g.
# ${x:-"a && b"} or ${x:-$(a || b)}. Rewrite those or narrow this regex.
# Prints line numbers only: the rendered script is not echoed into CI logs.
if leaks="$(grep -nE '\$\{[^}]*(==|!=|&&|\|\|| \? )' "$WORK/user-data.sh" | cut -d: -f1 | paste -sd, -)" && [ -n "$leaks" ]; then
  fail "rendered user_data line(s) $leaks: HCL expression inside bash \${…} (use \$\${ only for bash variables; may be a false positive, see comment above)"
fi
echo "  ✓ user_data renders, #!/bin/bash first, bash -n clean, no leaked HCL expressions"
