"""Verify named SDK imports against the real local TypeScript export surface.

Static verification only, not a host render or TypeScript runtime evaluation.
"""
import argparse
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument("--hermes-root", type=Path, required=True)
args = parser.parse_args()
plugin = (Path(__file__).parents[1] / "desktop/plugin.js").read_text(encoding="utf-8")
sdk_path = args.hermes_root / "apps/desktop/src/sdk/index.ts"
sdk = sdk_path.read_text(encoding="utf-8")
exports = set(re.findall(r"export\s+(?:const|function|class)\s+(\w+)", sdk))
for group in re.findall(r"export\s*\{([^}]+)\}", sdk, re.S):
    for part in group.split(","):
        part = part.strip()
        if part.startswith("type "):
            continue
        name = part.split(" as ")[-1].strip()
        if re.fullmatch(r"\w+", name):
            exports.add(name)
imports = re.findall(r"import\s*\{([^}]+)\}\s*from\s*['\"]@hermes/plugin-sdk['\"]", plugin)
required = {name.strip().split(" as ")[0] for group in imports for name in group.split(",")}
missing = required - exports
if missing:
    raise SystemExit("Missing real SDK exports: " + ", ".join(sorted(missing)))
print("PASS real SDK named exports:", ", ".join(sorted(required)))
print("Source:", sdk_path)
print("Static export check only; host mounting remains unverified.")
