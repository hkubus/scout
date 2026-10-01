#!/bin/bash
# Builds the app for an iPhone simulator, launches it on demo data once per
# screen, and saves screenshots to out/screenshots. Run from ios/ after
# `xcodegen generate`.
set -eo pipefail

BUNDLE_ID=io.github.hkubus.scout
OUT=out/screenshots
mkdir -p "$OUT"

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devices = json.load(sys.stdin)["devices"]
def runtime_version(runtime):
    match = re.search(r"iOS-(\d+)-(\d+)", runtime)
    return tuple(int(part) for part in match.groups()) if match else (0, 0)
iphones = [
    (runtime_version(runtime), "Pro" in device["name"] and "Max" not in device["name"], device["udid"])
    for runtime, entries in devices.items() if "iOS" in runtime
    for device in entries if device["name"].startswith("iPhone")
]
print(max(iphones)[2])
')
echo "Using simulator $UDID"

xcodebuild -project Scout.xcodeproj -scheme Scout -configuration Debug \
  -destination "id=$UDID" -derivedDataPath build/simulator \
  CODE_SIGNING_ALLOWED=NO -quiet build
APP=build/simulator/Build/Products/Debug-iphonesimulator/Scout.app

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
xcrun simctl install "$UDID" "$APP"

capture() {
  local name=$1
  shift
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE_ID" "$@" >/dev/null
  sleep 5
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null
  echo "Captured $name"
}

xcrun simctl ui "$UDID" appearance light
capture connect
for screen in deals search listing watches watch new-watch research analytics flips settings widgets; do
  capture "$screen" -ScoutDemo YES -ScoutScreen "$screen"
done
xcrun simctl ui "$UDID" appearance dark
capture deals-dark -ScoutDemo YES -ScoutScreen deals
capture listing-dark -ScoutDemo YES -ScoutScreen listing
capture settings-dark -ScoutDemo YES -ScoutScreen settings
capture widgets-dark -ScoutDemo YES -ScoutScreen widgets
capture analytics-dark -ScoutDemo YES -ScoutScreen analytics
