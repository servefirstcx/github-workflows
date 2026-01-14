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

### 5. ECS Deployment Workflow (`deploy-ecs.yml`)

Deploys Docker containers to AWS ECS with proper task definition management. This workflow:
- Builds and pushes Docker images to ECR with commit SHA tags
- Creates a new task definition revision for each deployment (enables rollbacks)
- Updates the ECS service to use the new task definition
- Waits for service stability
- Sends deployment notifications to Slack (optional)

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

### Example: ECS Deployment Workflow

Create `.github/workflows/deploy.yml` in your repository:

```yaml
name: Deploy Service

on:
  push:
    branches: [main, stage]
  workflow_dispatch:
    inputs:
      environment:
        description: "Environment to deploy to"
        required: true
        type: choice
        options:
          - staging
          - production
      branch:
        description: "Branch to deploy"
        required: false
        type: string

env:
  SERVICE_NAME: pdf  # Change for your service
  SERVICE_DISPLAY_NAME: PDF Service  # Change for your service

jobs:
  setup:
    name: Determine Environment
    runs-on: ubuntu-latest
    outputs:
      environment: ${{ steps.set-env.outputs.environment }}
      branch: ${{ steps.set-env.outputs.branch }}
      aws_region: ${{ steps.set-env.outputs.aws_region }}
      ecr_repository: ${{ steps.set-env.outputs.ecr_repository }}
      ecs_service: ${{ steps.set-env.outputs.ecs_service }}
      ecs_cluster: ${{ steps.set-env.outputs.ecs_cluster }}
      version: ${{ steps.version-check.outputs.version }}
      is_release: ${{ steps.version-check.outputs.is_release }}
      has_tag: ${{ steps.version-check.outputs.has_tag }}
    steps:
      # ... setup steps to determine environment and check version ...

  build-and-deploy:
    name: Build and Deploy
    needs: setup
    uses: servefirstcx/github-workflows/.github/workflows/deploy-ecs.yml@main
    with:
      service_name: ${{ env.SERVICE_NAME }}
      service_display_name: ${{ env.SERVICE_DISPLAY_NAME }}
      environment: ${{ needs.setup.outputs.environment }}
      branch: ${{ needs.setup.outputs.branch }}
      aws_region: ${{ needs.setup.outputs.aws_region }}
      ecr_repository: ${{ needs.setup.outputs.ecr_repository }}
      ecs_service: ${{ needs.setup.outputs.ecs_service }}
      ecs_cluster: ${{ needs.setup.outputs.ecs_cluster }}
      version: ${{ needs.setup.outputs.version }}
      is_release: ${{ needs.setup.outputs.is_release }}
      has_tag: ${{ needs.setup.outputs.has_tag }}
      commit_sha: ${{ github.sha }}
    secrets:
      AWS_ROLE_TO_ASSUME: ${{ needs.setup.outputs.environment == 'production' && secrets.AWS_ROLE_TO_ASSUME_PROD || secrets.AWS_ROLE_TO_ASSUME_STAGING }}
      SLACK_WEBHOOK_URL: ${{ needs.setup.outputs.environment == 'production' && secrets.SLACK_WEBHOOK_URL_PROD || secrets.SLACK_WEBHOOK_URL_STAGING }}
```

**Key Features:**
- ✅ Creates a new task definition revision for each deployment
- ✅ Uses commit SHA for image tagging (not `:latest`)
- ✅ Enables easy rollbacks to previous revisions
- ✅ Full audit trail in ECS
- ✅ Optional Slack notifications

**Required Secrets:**
- `AWS_ROLE_TO_ASSUME_PROD`: AWS IAM role ARN for production deployments
- `AWS_ROLE_TO_ASSUME_STAGING`: AWS IAM role ARN for staging deployments
- `SLACK_WEBHOOK_URL_PROD`: (Optional) Slack webhook for production notifications
- `SLACK_WEBHOOK_URL_STAGING`: (Optional) Slack webhook for staging notifications

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
