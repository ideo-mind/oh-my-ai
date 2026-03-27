# oh-my-ai

## 1.0.2

### Patch Changes

- 8534b90: Create a default config file at `CONFIG_FILE` when missing so first run works out of the box, using default server settings and an admin password fallback.

## 1.0.1

### Patch Changes

- Add a Bun CLI bin entry so `bunx oh-my-ai` resolves an executable runner, and pass `NPM_TOKEN` explicitly in the release workflow publish step.
- 6c38047: Prepare the project for public releases by standardizing package metadata, aligning GPL licensing declarations, and adding release automation for Bun binaries with Changesets-based versioning.
