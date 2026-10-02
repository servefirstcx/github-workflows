# Release summaries and deployment notifications

## What changes

Release PRs contain a short overview, followed by the actual included PRs and linked Jira tickets. The generated section is identified by `sf-release-notes` markers. GitHub Release publication copies this reviewed section; deployment notifications reuse it. Deployment never calls an AI model or reads from Jira.

The collector uses pinned production and release commits, not a date window or the latest stage branch. Missing AI/Jira credentials use a complete title/link fallback. Inventory collection failures are errors, not a falsely complete list. Model output cannot add/remove source items or supply links.

The one Jira write is optional and happens after a successful production deploy: the deployment notification can report released ticket keys to a Jira Automation webhook (see [Marking Jira tickets as released](#marking-jira-tickets-as-released)).

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

Capture `deployed` outputs from the actual checkout using `git rev-parse HEAD` and the checkout's package.json. Do not substitute `github.sha`: a manual deployment can select a different ref. Where setup/build are separate jobs, resolve the ref once and pin build to that SHA. Grant the notification job only `contents: read` and `pull-requests: read` (plus `deployments: read` if it reports to Jira, see below); preserve the actual deployment job's existing OIDC/deployment permissions.

For a separate notification-only job, use `environment: { name: <target>, deployment: false }` to retain environment-scoped secrets without creating a misleading successful deployment record. Pass the actual setup/deployment job results through `needs`, not the notification job's own `job.status`. GitHub does not support `deployment: false` with custom deployment protection rules; check the target environments first.

API and Console use separate notification jobs in the companion PRs. The shared ECS/S3 workflows are deliberately not switched automatically in this change, to avoid surprising other callers with new token permissions. They can adopt the same composite action separately.

## Marking Jira tickets as released

GitHub for Jira only links a production deployment to tickets it finds in roughly the first ~100 commits since the previous deployment (observed, not documented). Weekly releases are routinely 100–300+ commits, so most shipped tickets never show as deployed. The notification action can instead send Jira the exact list of tickets a production deploy shipped.

### Which tickets count

A ticket counts as shipped by a change only if:

- its key is in the **branch name**, for example `SF-4401-gridspot-image-lost` or `feat/SF-12-export`, or
- a line in the PR description or a commit message **starts with "Closes"**: `Closes SF-123`, `Closes: SF-1, SF-2 and SF-3`, `* Closes SF-123` or `Closes [SF-123](https://servefirst.atlassian.net/browse/SF-123)`. `Closed` also works. "…it closes SF-1" in the middle of a sentence does not count. For a squash merge, only the final squash message is read, so keep the Closes line in it (GitHub's default squash message already includes the commit messages).

Mentions anywhere else never count: PR titles, "Depends on SF-9", "Follow-up to SF-8", or a key in passing text. So a branch without a key, such as `csat-sms-step-1`, needs a `Closes SF-…` line or its ticket is not moved. A hotfix with a fix commit that says `Closes SF-…` (or that comes from a ticket branch) reports it too. A "Closes" line in the release or hotfix PR description itself also counts, which helps for direct commits. The release notes use the same rule for their ticket links. They cover only this release PR's range, so after a skipped deploy Jira can be told about more tickets than the notes list.

### What is sent, and when

Only on a **successful production** deploy, the action rebuilds the list from GitHub at deploy time. Each commit is matched to its PR with GitHub's commit-to-PR lookup, so merge, squash and rebase merges all work. Editing the generated notes block does not change which tickets are reported.

- **Range:** from the previous successful production deployment recorded in GitHub to the deployed commit. A release that merged but never deployed is then still reported by the next deploy that ships it. If there is no earlier production deployment at all, only this release PR's changes are reported, with a warning. If deployments can't be read (the job lacks `deployments: read`), nothing is sent and the step fails so it is visible.
- **Reverts:** a revert never reports a ticket, and every ticket on what it reverts is left out, even if another change also closes it. A revert of a revert also leaves the ticket out. When unsure, a ticket is left out rather than closed; move those by hand.
- **Rollbacks:** deploying an older or the same version as the previous production deploy reports nothing, and so does a deploy whose history doesn't include the previous one.
- **Payload:** ticket keys in batches of 50:

```json
{"issues": ["SF-4300", "SF-4401"], "data": {"repository": "servefirstcx/sf-api", "version": "4.25.0", "notesUrl": "https://github.com/servefirstcx/sf-api/releases/tag/v4.25.0"}}
```

Nothing is validated or sent for staging, dev or failed deploys. GitHub holds only the webhook URL and secret, which can do nothing except trigger that one rule. It holds no Jira user credential. What happens to the tickets is defined, and visible, in Jira.

### Jira rule (SF project)

1. Trigger: *Incoming webhook*, "Issues provided in the webhook HTTP POST body". Copy the URL and secret.
2. Condition (JQL): `project = SF AND status = "Dev Complete" AND issuetype != Epic`. Only tickets the team has marked Dev Complete move. Other projects, epics and tickets still in progress are ignored. This also covers a ticket split across repositories or PRs: it only moves once someone marks it Dev Complete, so leave it in progress until every part has merged.
3. Action: transition to *Done (In Production)*.
4. Action: comment `Released to production in {{webhookData.data.repository}} v{{webhookData.data.version}}: {{webhookData.data.notesUrl}}` (the extra fields sit under `data` in the POST body).

This rule exists in SF as **"Release workflow → mark released tickets Done (In Production)"**. The old sprint-close rule that bulk-moved Dev Complete tickets has been disabled.

### Wiring a repository

Store the URL and secret as Actions secrets **`JIRA_RELEASE_WEBHOOK_URL`** and **`JIRA_RELEASE_WEBHOOK_SECRET`** (org secrets visible to the application repositories). Only the current `api-private.atlassian.com/automation/webhooks/jira/...` URL is accepted, and the secret is required: Atlassian retired the old `automation.atlassian.com/pro/hooks` URLs on 30 May 2025. Pass both to the notification step, and give the notification job `deployments: read`:

```yaml
    permissions:
      contents: read
      pull-requests: read
      deployments: read
    ...
        jira-webhook-url: ${{ secrets.JIRA_RELEASE_WEBHOOK_URL }}
        jira-webhook-secret: ${{ secrets.JIRA_RELEASE_WEBHOOK_SECRET }}
```

### Failures and reruns

Slack and Jira are independent: either can be configured alone, and a failure in one does not skip the other. Either failure still fails the (non-blocking) notification step so it is visible. If a batch fails, the error says how many tickets were already sent. Rerunning the job resends all of them, and the Dev Complete condition skips tickets that already moved. A ticket moved back to Dev Complete after release can be moved again by a rerun of that deploy.

Atlassian's endpoint can return HTTP 200 even when the secret is wrong or the rule is disabled, so the log says "webhook returned success", not "updated". Check the rule's audit log after the first real deploy.

Use `DRY_RUN=true` to print the tickets a production deploy would report without sending anything.

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
