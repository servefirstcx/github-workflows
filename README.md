# Shared GitHub Workflows

This repository contains reusable GitHub Actions workflows for ServeFirst repositories.

## Available Workflows

### 1. Release Workflow (`release.yml`)

Creates a release PR with version bump.

### 2. Tag Release Workflow (`tag-release.yml`)

Automatically tags releases when PRs are merged to main.

### 3. Sync Release Workflow (`sync-release.yml`)

Syncs releases back from main to stage.

### 4. Hotfix Workflow (`hotfix.yml`)

Creates a hotfix PR from `main` with a version bump (default: patch) and labels it as a release so your tagging workflow runs on merge. After tagging, your sync workflow can merge `main` back to `stage`.

## Usage

To use these workflows in your repository, create minimal wrapper workflows that call these reusable ones.

### Example: Release Workflow

Create `.github/workflows/release.yml` in your repository:

```yaml
name: Create Release PR

on:
  workflow_dispatch:
    inputs:
      version_type:
        description: "Version type"
        required: true
        default: "minor"
        type: choice
        options:
          - major
          - minor
          - patch

jobs:
  release:
    uses: servefirstcx/github-workflows/.github/workflows/release.yml@main
    with:
      version_type: ${{ inputs.version_type }}
      # Optional: Override defaults
      # staging_branch: develop
      # main_branch: master
      # package_file: version.json
```

### Example: Tag Release Workflow

Create `.github/workflows/tag-release.yml` in your repository:

```yaml
name: Tag Release

on:
  pull_request:
    types: [closed]
    branches: [main]

jobs:
  tag:
    uses: servefirstcx/github-workflows/.github/workflows/tag-release.yml@main
    # with:
    #   main_branch: master
    #   release_label: release
```

### Example: Sync Release Workflow

Create `.github/workflows/sync-release.yml` in your repository:

```yaml
name: Sync Release to Stage

on:
  push:
    tags:
      - "v*"

jobs:
  sync:
    uses: servefirstcx/github-workflows/.github/workflows/sync-release.yml@main
    # with:
    #   staging_branch: develop
    #   main_branch: master
```

## Configuration

All workflows support optional configuration inputs. The defaults are:

- `staging_branch`: "stage"
- `main_branch`: "main"
- `package_file`: "package.json"
- `package_lock`: "package-lock.json"
- `bot_name`: "github-actions[bot]"
- `bot_email`: "github-actions[bot]@users.noreply.github.com"
- `release_label`: "release"
- `tag_prefix`: "v"

## Requirements

1. Make sure this repository (`servefirstcx/github-workflows`) is accessible to your other repositories
2. Repositories using these workflows need appropriate permissions:
   - `contents: write` (for pushing branches/tags)
   - `pull-requests: write` (for creating PRs)

## Benefits

- **Single source of truth**: Update workflows in one place
- **Consistency**: All repos follow the same release process
- **Minimal maintenance**: Wrapper workflows are tiny (10-15 lines)
- **Easy updates**: Change the shared workflow, all repos get the update
- **Customizable**: Override defaults as needed per repository
