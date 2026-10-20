#!/bin/sh
# Prints the Team ID of your Apple Development certificate (the OU in its
# subject), ready to paste into ios/Config/Local.xcconfig. Needs a certificate,
# which Xcode creates the first time it signs an app for you.
set -e
found=0
security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | while IFS= read -r name; do
    team=$(security find-certificate -c "$name" -p | openssl x509 -noout -subject -nameopt multiline 2>/dev/null \
        | sed -n 's/^ *organizationalUnitName *= *//p' | head -1)
    [ -n "$team" ] && echo "DEVELOPMENT_TEAM = $team    // $name"
done | tee /dev/stderr | grep -q . || { echo "No Apple Development certificate found yet." >&2; exit 1; }
