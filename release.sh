#!/usr/bin/env bash
# Releases the version in plugin.toml, from this machine, with your signing key:
#
#   1. checks the tree, runs the tests, builds, and signs the package;
#   2. (after you confirm) tags vX.Y.Z and publishes a GitHub release with the
#      signed .oiplugin attached;
#   3. (after you confirm) opens the pull request that adds the version to the
#      community registry, l0ng-ai/openidea-plugins.
#
# Bump `version` and `change-notes` in plugin.toml (and web-src/package.json,
# Cargo.toml) and commit to main first. Nothing is signed, tagged or pushed
# until the checks pass, and the private key never leaves this machine.
#
#   ./release.sh                     the routine update
#   ./release.sh --dry-run           build, sign and check only; publish nothing
#   ./release.sh --key PATH          signing key (default ~/.config/openidea/keys/<publisher>.key)
#   ./release.sh --public-key KEY    first release only: also add publishers/<publisher>.toml
#                                    (the public key `openidea-plugin keygen` printed)
#   ./release.sh --yes               skip the confirmations (for a rerun you trust)
#   ./release.sh --no-pr             stop after the GitHub release
#
# Requires: gh (logged in as the registry owner), openidea-plugin, rustup,
# pnpm, git, shasum.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

REGISTRY="l0ng-ai/openidea-plugins"

dry=0 yes=0 pr=1 key="" public_key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --yes) yes=1 ;;
    --no-pr) pr=0 ;;
    --key) key="${2:?--key needs a path}"; shift ;;
    --public-key) public_key="${2:?--public-key needs a value}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }

field() {
  sed -n "s/^$1 *= *\"\([^\"]*\)\".*/\1/p" plugin.toml | head -n 1
}
confirm() {
  [ "$yes" = 1 ] && return 0
  read -r -p "$1 [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ]
}

id="$(field id)"
version="$(field version)"
change_notes="$(field change-notes)"
publisher="${id%%.*}"
[ -n "$id" ] && [ -n "$version" ] || die "plugin.toml has no id or version"
tag="v$version"
package="dist/$id-$version.oiplugin"
key="${key:-$HOME/.config/openidea/keys/$publisher.key}"

# ---------------------------------------------------------------- preflight
say "preflight: $id $version"
command -v gh >/dev/null || die "gh is not installed"
command -v openidea-plugin >/dev/null || die "openidea-plugin is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
[ -f "$key" ] || die "no signing key at $key (openidea-plugin keygen $key)"
mode="$(stat -f '%Lp' "$key" 2>/dev/null || stat -c '%a' "$key")"
[ "$mode" = 600 ] || die "$key must be mode 600 (chmod 600 '$key'), is $mode"

[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes"
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || die "release from main (on $branch)"
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main: push or pull first"
[ -z "$(git tag -l "$tag")" ] && ! git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 \
  || die "tag $tag already exists: bump the version in plugin.toml"

# Keep every place a version lives in step with the manifest.
cargo_version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
web_version="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' web-src/package.json | head -n 1)"
[ "$cargo_version" = "$version" ] || die "Cargo.toml version $cargo_version != plugin.toml $version"
[ "$web_version" = "$version" ] || die "web-src/package.json version $web_version != plugin.toml $version"
grep -qF "$version" <<<"$change_notes" || die "change-notes in plugin.toml does not mention $version"

# --------------------------------------------------------- test, build, sign
say "tests"
cargo test --locked --quiet
CI=true pnpm --dir web-src install --frozen-lockfile --silent
pnpm --dir web-src run typecheck

say "build"
./build.sh
openidea-plugin check

say "sign"
rm -f "$package"
openidea-plugin pack . --key "$key" --publisher "$publisher" --out "$package"
openidea-plugin check "$package"
sha="$(shasum -a 256 "$package" | cut -d' ' -f1)"
echo "sha256 $sha"

if [ "$dry" = 1 ]; then
  say "dry run: stopping before anything is published"
  exit 0
fi

# ------------------------------------------------------------ GitHub release
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
visibility="$(gh repo view --json visibility -q .visibility)"
[ "$visibility" = PUBLIC ] || die "$repo is $visibility: the registry needs a public repository"

say "GitHub release"
echo "repository  $repo"
echo "tag         $tag (at $(git rev-parse --short HEAD))"
echo "asset       $package"
confirm "Tag and publish the release?" || die "stopped before publishing"

git tag -a "$tag" -m "$id $version"
git push origin "$tag"
gh release create "$tag" "$package" --repo "$repo" --title "$version" --notes "$change_notes"

# What the registry will download must be the file we signed.
url="https://github.com/$repo/releases/download/$tag/$(basename "$package")"
check_dir="$(mktemp -d)"
trap 'rm -rf "$check_dir"' EXIT
gh release download "$tag" --repo "$repo" -p "$(basename "$package")" -D "$check_dir"
[ "$(shasum -a 256 "$check_dir/$(basename "$package")" | cut -d' ' -f1)" = "$sha" ] \
  || die "the uploaded asset does not match the signed package"
echo "release verified: $url"

[ "$pr" = 1 ] || { echo "skipped the registry PR (--no-pr)"; exit 0; }

# ------------------------------------------------------------- registry PR
say "registry pull request"
me="$(gh api user -q .login)"
confirm "Open a PR to $REGISTRY adding $id $version, as $me?" || { echo "stopped; the release is published"; exit 0; }

gh repo fork "$REGISTRY" --clone=false >/dev/null 2>&1 || true
work="$check_dir/registry"
gh repo clone "$me/openidea-plugins" "$work" -- -q
cd "$work"
git remote add upstream "https://github.com/$REGISTRY.git" 2>/dev/null || true
git fetch -q upstream main
branch="$id-$version"
git checkout -q -B "$branch" upstream/main

plugin_file="plugins/$id.toml"
publisher_file="publishers/$publisher.toml"
mkdir -p plugins publishers

if [ ! -f "$publisher_file" ]; then
  [ -n "$public_key" ] || die "no $publisher_file in the registry: this is a first release, pass --public-key"
  cat >"$publisher_file" <<EOF
name = "$(sed -n 's/^authors *= *\["\([^"]*\)".*/\1/p' "$here/plugin.toml" | head -n 1)"
owners = ["$me"]
keys = ["$public_key"]
revoked-keys = []
EOF
fi

if [ -f "$plugin_file" ]; then
  grep -q "^version = \"$version\"" "$plugin_file" && die "$plugin_file already lists $version"
else
  printf 'repository = "https://github.com/%s"\n' "$repo" >"$plugin_file"
fi
cat >>"$plugin_file" <<EOF

[[versions]]
version = "$version"
package = "$url"
sha256 = "$sha"
EOF

git add plugins publishers
git commit -q -m "$id $version"
git push -q -u origin "$branch" --force-with-lease
gh pr create --repo "$REGISTRY" --base main --head "$me:$branch" \
  --title "$id $version" \
  --body "$change_notes

Package: $url
SHA-256: \`$sha\`
Signed with the \`$publisher\` publisher key.
Source: https://github.com/$repo/releases/tag/$tag"
