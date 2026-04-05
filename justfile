set shell := ["sh", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]
set dotenv-filename := ".env"
set export := true

import? "local.justfile"

# The default task is `start`, so running `just` will execute it.
default: start

# --- Development ---

# Run the main application
start:
    @echo "Starting the application..."
    @bun start

# Run the main application in watch mode
dev:
    @echo "Starting the application in watch mode..."
    @bun --watch index.ts

# --- Dependencies ---

# Install dependencies
install:
    @echo "Installing dependencies..."
    @bun install

# --- Testing ---

# Run tests
test:
    @echo "Running tests..."
    @bun test

# --- Production Simulation ---

# This recipe calls the appropriate OS-specific implementation below.
prod:
    @just --justfile {{ justfile() }} _prod-loop

# Hidden recipe for the Windows loop
[windows]
_prod-loop:
    @echo 'Running on Windows in a PowerShell loop...'
    @powershell -NoProfile -Command "while ($true) { bun start; Start-Sleep -Seconds 1 }"

# Hidden recipe for the Unix loop
[unix]
_prod-loop:
    @echo 'Running on a Unix-like system in a bash loop...'
    @bash -c 'while true; do bun start; sleep 1; done'

# --- Release ---

# Create a new changeset
changeset:
    @bun run changeset

# Version packages based on changesets
version:
    @bun run version-packages
