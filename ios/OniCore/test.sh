#!/bin/sh
# Runs OniCore's tests with only the Command Line Tools installed (no Xcode):
# `swift test` needs to be pointed at the Testing framework the CLT ship.
# (This CLT build also ships an empty _Testing_Foundation overlay, hence
# -disable-cross-import-overlays; it only drops Testing's Foundation extras.)
# With full Xcode installed, plain `swift test` works and these flags are unneeded.
set -e
cd "$(dirname "$0")"
CLT=/Library/Developer/CommandLineTools
F=$CLT/Library/Developer/Frameworks
P=$CLT/usr/lib/swift/host/plugins/testing
if [ -d "$F/Testing.framework" ] && ! xcodebuild -version >/dev/null 2>&1; then
    exec swift test -Xswiftc -F"$F" -Xlinker -F"$F" -Xlinker -rpath -Xlinker "$F" \
        -Xswiftc -plugin-path -Xswiftc "$P" \
        -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays "$@"
fi
exec swift test "$@"
