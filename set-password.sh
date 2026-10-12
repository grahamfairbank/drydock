#!/bin/sh
# Change the Drydock console password.
#
#   ./set-password.sh              prompt for a new password
#   ./set-password.sh --generate   create a random one and print it
#
# Drydock reads its password from the environment when its container is
# created, so editing .env alone changes nothing. This script writes the new
# password to .env and re-creates the container so it takes effect. Everyone
# who is signed in has to sign in again.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "No .env file here. Copy .env.example to .env and fill it in first." >&2
    exit 1
fi

case "${1:-}" in
    "")
        if [ ! -t 0 ]; then
            echo "Run this from a terminal, or use --generate." >&2
            exit 1
        fi
        trap 'stty echo 2>/dev/null' EXIT INT TERM
        stty -echo
        printf 'New password: '
        IFS= read -r new
        printf '\nRepeat it:    '
        IFS= read -r again
        printf '\n'
        stty echo
        trap - EXIT INT TERM
        if [ "$new" != "$again" ]; then
            echo "The two entries do not match. Nothing was changed." >&2
            exit 1
        fi
        ;;
    -g|--generate)
        new=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
        echo "New password: $new"
        ;;
    *)
        sed -n '2,10s/^# \{0,1\}//p' "$0"
        exit 1
        ;;
esac

if [ "${#new}" -lt 8 ]; then
    echo "Choose a password of at least 8 characters. Nothing was changed." >&2
    exit 1
fi
case "$new" in
    *"'"*|*\\*)
        echo "Single quotes and backslashes are not supported. Nothing was changed." >&2
        exit 1
        ;;
esac

# Rewrite .env with the new value, single-quoted so compose takes it literally.
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"
grep -v '^DRYDOCK_PASSWORD=' .env > "$tmp" || true
printf "DRYDOCK_PASSWORD='%s'\n" "$new" >> "$tmp"
mv "$tmp" .env
trap - EXIT

echo "Applying..."
docker compose up -d --wait
echo "Password changed. Sign in again with the new password."
