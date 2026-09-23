# Release summaries and deployment notifications

## What changes

Release PRs contain a short overview, followed by the actual included PRs and linked Jira tickets. The generated section is identified by `sf-release-notes` markers. GitHub Release publication copies this reviewed section; deployment notifications reuse it. Deployment never calls an AI model or Jira.

The collector uses pinned production and release commits, not a date window or the latest stage branch. Missing AI/Jira credentials use a complete title/link fallback. Inventory collection failures are errors, not a falsely complete list. Model output cannot add/remove source items or supply links.

PR descriptions and Jira text are sent to GitHub Models only when `MODELS_TOKEN` is configured. No credentials are included in the prompt. Jira enrichment reads only ticket summary/description, not comments or attachments. Model output is a draft for review, not proof that a ticket is complete or that a deployment passed.

## Setup for an organisation administrator

1. Enable the selected GitHub Models model for the organisation and allow its usage/billing. Default model: `openai/gpt-4.1-mini`; override the reusable workflow's `ai_model` input if needed.
2. Create a GitHub credential with **Models: read** permission and access allowed by organisation policy. Store it as the Actions secret **`MODELS_TOKEN`**, scoped only to the participating application repositories. This is a GitHub token, not an OpenAI API key. No code-write or deployment privileges are needed for inference. This separate optional token avoids adding `models: read` to every existing caller's `GITHUB_TOKEN` permissions.
3. Optional Jira enrichment: use a service account restricted to browsing the SF project, with no issue-write/admin permissions. Store **`JIRA_EMAIL`** and **`JIRA_API_TOKEN`** as Actions secrets on those same repositories. Pass `jira_base_url` if it differs from `https://servefirst.atlassian.net`. Use a credential compatible with that site's REST API URL. Do not paste credentials into PRs, logs or chat.
4. Keep the existing **`SLACK_WEBHOOK_URL_PROD`** and **`SLACK_WEBHOOK_URL_STAGING`** secrets. No Slack bot token or Slack history access is needed.
5. Ensure the private `github-workflows` repository's Actions access policy allows these callers to use both reusable workflows and composite actions.

The workflows still function without steps 1–3: the PR list is deterministic, but prose enrichment is unavailable. GitHub repository access failures do not silently degrade into missing inventory.

## Caller wiring

Release creation forwards only the new optional secrets, not every organisation secret:

```yaml
jobs:
  release:
    uses: servefirstcx/github-workflows/.github/workflows/release.yml@main
    with:
      version_type: ${{ inputs.version_type }}
    secrets:
      MODELS_TOKEN: ${{ secrets.MODELS_TOKEN }}
      JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
      JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
```

Release tagging requires `contents: write` and `pull-requests: read`. The existing optional `RELEASE_TOKEN` remains for tags that must trigger other workflows. The tagged commit is now the merged PR's exact merge commit, not a subsequently advanced main branch.

Add a refresh caller on `pull_request` opened/synchronize/reopened targeting production, using `.github/workflows/refresh-release-notes.yml@main`. Restrict it to same-repository `release/*` or `hotfix/*` branches. Use `contents: read`, `pull-requests: write`, and explicitly forward the three optional secrets above. The shared workflow independently checks these restrictions. It never runs scripts from the application checkout.

In standalone deployment jobs, replace the old `8398a7/action-slack` step:

```yaml
- name: Send deployment notification
  if: always()
  continue-on-error: true
  uses: servefirstcx/github-workflows/.github/actions/deployment-notification@main
  with:
    status: ${{ job.status }}
    environment: ${{ needs.setup.outputs.environment }}
    version: ${{ steps.deployed.outputs.version }}
    deployed-sha: ${{ steps.deployed.outputs.sha }}
    webhook-url: ${{ secrets.SLACK_WEBHOOK_URL_PROD }} # select explicitly by environment
```

Capture `deployed` outputs from the actual checkout using `git rev-parse HEAD` and the checkout's package.json. Do not substitute `github.sha`: a manual deployment can select a different ref. Where setup/build are separate jobs, resolve the ref once and pin build to that SHA. Grant the notification job only `contents: read` and `pull-requests: read`; preserve the actual deployment job's existing OIDC/deployment permissions.

For a separate notification-only job, use `environment: { name: <target>, deployment: false }` to retain environment-scoped secrets without creating a misleading successful deployment record. Pass the actual setup/deployment job results through `needs`, not the notification job's own `job.status`. GitHub does not support `deployment: false` with custom deployment protection rules; check the target environments first.

API and Console use separate notification jobs in the companion PRs. The shared ECS/S3 workflows are deliberately not switched automatically in this change, to avoid surprising other callers with new token permissions. They can adopt the same composite action separately.

## Editing, freshness and delivery

- New release PRs start as drafts and become ready for review only after their notes and release label are verified. If GitHub fails partway through, rerun the release workflow with the same version type: an existing release branch with the expected package version and its exact open PR are reused. Existing commits and edited PR text are preserved; ambiguous, closed or mismatched releases require manual resolution rather than a force-push or overwrite.
- Edit wording inside the marked notes section before merging. Publication and Slack reuse it without another model call.
- After new release-branch commits, refresh posts a **review comment with copyable replacement notes**. Review it and replace the marked section in the description before merging. It never rewrites the description, checklist or other bots' sections. GitHub does not offer an atomic conditional PR-body PATCH, so a GET/PATCH loop could lose concurrent human edits. See [GitHub conditional request limitations](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate). Reopening a PR whose body already has the current source does not regenerate it.
- Initial hotfix PRs may contain only a version bump. The refresh caller suggests notes after the actual fix is pushed; apply them to the PR description after review. Without that caller, legacy/hotfix descriptions get an explicit unavailable-summary fallback, not invented release contents.
- Production notification checks the exact version tag against the deployed SHA, and verifies note provenance against the associated merged release PR. It never requests `/releases/latest`. If publication races deployment, it can use the matching merged PR. Missing/stale/mismatched notes yield a concise unavailable-summary message.
- Staging/dev and failed/cancelled deployments do not announce production release contents. A successful redeploy of the same tagged commit reuses that version's notes; it is not a claim that the changes are new since the previous deployment.
- Slack shows repo, deployment status, environment, version, notes and links. No branch/hash/deployer fields, action-slack attachments or link/media previews. Slack's own app attribution is outside the payload's control.
- Oversized Slack notes are explicitly shortened with a link to the full release notes. Inventory is not silently dropped from the release PR; a PR body beyond GitHub's limit fails visibly.
- Notification failure is non-blocking for a completed deploy. Inspect the notification step if a webhook rejects the payload.

## Rollout and verification

Merge shared support first, then the application caller PRs. Application PRs should pin the reviewed shared commit. Reusable workflows currently reference their repository's `@main` composite actions, so do not dispatch these new workflows before the shared support is on main.

Promote workflow changes to production branches through the normal release process. A change merged only to stage does not necessarily change the workflow used by a push to main.

Run `node --test tests/*.test.mjs` for the built-in Node test suite. It uses labelled fixtures for external HTTP operations and never posts to Slack. CI also lints the changed reusable workflows with actionlint.

The notification CLI supports `DRY_RUN=true` and `PAYLOAD_FILE=/path/to/payload.json` to render without posting. Configure `GH_TOKEN`, `GITHUB_REPOSITORY`, `DEPLOYED_SHA`, `VERSION`, `ENVIRONMENT`, `DEPLOY_STATUS` and `RUN_URL` as documented by the action. Do not set a production webhook for a preview. A local dry run proves rendering/lookup, not Slack delivery or the organisation's model policy.

Before the first real production deployment, inspect a generated release PR: check the included PR/ticket list, AI/Jira fallback warnings, and manual edits. Following deployment, confirm the saved release notes and Slack message correspond to the deployed version. Model entitlement, Jira credential access and actual webhook delivery require configured organisation credentials; unit tests do not prove those external permissions.
