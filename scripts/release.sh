#!/bin/bash

# Ensure gum is installed
if ! command -v gum &> /dev/null
then
    echo "gum could not be found. Please install it: https://github.com/charmbracelet/gum#installation"
    exit 1
fi

# 1. Select version bump type
VERSION_TYPE=$(gum choose "patch" "minor" "major")

# 2. Add a changeset if none exists
if [ ! -d ".changeset" ]; then
    gum log --level info "No changesets found. Creating a default one."
    bun run changeset add --empty --"$VERSION_TYPE" --message="chore: release"
fi

# 3. Run version-packages
gum spin --title "Versioning packages..." -- bun run version-packages

# Get the new version from package.json
NEW_VERSION=$(jq -r .version package.json)

# 4. Commit version changes
git add .
git commit -m "chore: release v$NEW_VERSION"

# 5. Create Git tag and prompt for message
gum style --foreground "#04B575" --border-foreground "#04B575" --border double --align center --width 50 --margin "1 2" --padding "2 4" "New version: v$NEW_VERSION"

TAG_MESSAGE=$(gum input --placeholder "Enter a tag message (optional)")

if [ -n "$TAG_MESSAGE" ]; then
    git tag -a "v$NEW_VERSION" -m "$TAG_MESSAGE"
else
    git tag "v$NEW_VERSION"
fi

# 6. Ask to push commit and tag
if gum confirm "Push version commit and tag (v$NEW_VERSION) to remote?"; then
    gum spin --title "Pushing version commit and tag..." -- git push origin HEAD && git push --tags
else
    gum log --level warn "Skipping push. Remember to push manually later: git push origin HEAD --tags"
fi

gum log --level info "Release v$NEW_VERSION process complete locally."
