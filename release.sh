#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Get current version from package.json
current=$(grep '"version"' package.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')
echo "Current version: $current"

# Split into parts
IFS='.' read -r major minor patch <<< "$current"

# Ask what kind of bump
echo "What kind of release?"
echo "  1) patch ($major.$minor.$((patch + 1)))"
echo "  2) minor ($major.$((minor + 1)).0)"
echo "  3) major ($((major + 1)).0.0)"
read -p "Choose [1/2/3]: " choice

case $choice in
  1) new="$major.$minor.$((patch + 1))" ;;
  2) new="$major.$((minor + 1)).0" ;;
  3) new="$((major + 1)).0.0" ;;
  *) echo "Invalid choice"; exit 1 ;;
esac

# Update package.json and package-lock.json together
npm version "$new" --no-git-tag-version

echo "Bumped to $new"

# Commit, tag, and push
git add -A
git commit -m "v$new"
git tag "v$new"
git push
git push --tags

echo "Release v$new triggered!"
open "https://github.com/flowtricks/stacki/actions"
