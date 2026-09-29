#!/usr/bin/env python3
"""Builds the GitHub Pages site that SideStore installs and updates Scout from.

The site holds the latest unsigned IPA, a SideStore/AltStore source
(`source.json`), the icon, the CI screenshots, and a small index page.
"""
import argparse
import datetime
import html
import json
import shutil
from pathlib import Path

BUNDLE_ID = "io.github.hkubus.scout"
TINT = "#1d61e8"
MIN_OS = "17.0"
SCREENS = ["deals", "listings", "listing", "watches", "watch", "settings"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument("--ipa", required=True, type=Path)
    parser.add_argument("--icon", required=True, type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    # Versioned file name so a cached old IPA is never served for a new build.
    ipa_name = f"Scout-{args.build}.ipa"
    shutil.copy(args.ipa, out / ipa_name)
    shutil.copy(args.icon, out / "icon.png")
    screenshots = []
    if args.screenshots and args.screenshots.is_dir():
        shutil.copytree(args.screenshots, out / "screenshots", dirs_exist_ok=True)
        screenshots = [f"{base}/screenshots/{name}.png" for name in SCREENS if (args.screenshots / f"{name}.png").exists()]

    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    size = (out / ipa_name).stat().st_size
    download = f"{base}/{ipa_name}"
    description = (
        "Native iPhone client for a self-hosted Scout server: the live deal feed, "
        "listing triage, watches, and asking-price analytics."
    )
    source = {
        "name": "Scout",
        "identifier": f"{BUNDLE_ID}.source",
        "sourceURL": f"{base}/source.json",
        "iconURL": f"{base}/icon.png",
        "tintColor": TINT,
        "apps": [
            {
                "name": "Scout",
                "bundleIdentifier": BUNDLE_ID,
                "developerName": "kubus",
                "subtitle": "Marketplace deal monitor",
                "localizedDescription": description,
                "iconURL": f"{base}/icon.png",
                "tintColor": TINT,
                "category": "utilities",
                "screenshots": screenshots,
                "versions": [
                    {
                        "version": args.version,
                        "buildVersion": args.build,
                        "date": now,
                        "localizedDescription": args.notes,
                        "downloadURL": download,
                        "size": size,
                        "minOSVersion": MIN_OS,
                    }
                ],
                # Legacy single-version fields for older SideStore releases.
                "version": args.version,
                "versionDate": now,
                "versionDescription": args.notes,
                "downloadURL": download,
                "size": size,
                "appPermissions": {
                    "entitlements": [],
                    "privacy": {"NSLocalNetworkUsageDescription": "Scout connects to your Scout server on your local network."},
                },
            }
        ],
        "news": [],
    }
    (out / "source.json").write_text(json.dumps(source, indent=2) + "\n")

    images = "\n".join(f'<img src="{html.escape(url)}" alt="">' for url in screenshots)
    (out / "index.html").write_text(f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout for iOS</title>
<style>
  body {{ font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }}
  code {{ word-break: break-all; }}
  .shots {{ display: flex; gap: 12px; overflow-x: auto; }}
  .shots img {{ width: 220px; border-radius: 16px; border: 1px solid #ddd; }}
</style>
<h1>Scout for iOS</h1>
<p>Version {html.escape(args.version)} ({html.escape(args.build)}) · built {html.escape(now)}</p>
<p>{html.escape(args.notes)}</p>
<p><a href="sidestore://source?url={html.escape(base)}/source.json">Add source to SideStore</a>
 or add <code>{html.escape(base)}/source.json</code> manually.</p>
<p><a href="{html.escape(download)}">Download the unsigned IPA</a> ({size / 1_048_576:.1f} MB)</p>
<div class="shots">
{images}
</div>
</html>
""")


if __name__ == "__main__":
    main()
