# Release summaries and deployment notifications

## What changes

Release PRs contain a short overview, followed by the actual included PRs and linked Jira tickets. The generated section is identified by `sf-release-notes` markers. GitHub Release publication copies this reviewed section; deployment notifications reuse it. Deployment never calls an AI model. It reads Jira only to publish release facts (see [Jira releases and Confluence release notes](#jira-releases-and-confluence-release-notes)).

The collector uses pinned production and release commits, not a date window or the latest stage branch. Missing AI/Jira credentials use a complete title/link fallback. Inventory collection failures are errors, not a falsely complete list. Model output cannot add/remove source items or supply links.

Jira and Confluence writes are optional and happen only after a successful production deploy: the deployment notification can report released ticket keys to a Jira Automation webhook (see [Marking Jira tickets as released](#marking-jira-tickets-as-released)), and publish the release's facts to a Jira release and a Confluence page (see [Jira releases and Confluence release notes](#jira-releases-and-confluence-release-notes)).

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

API and Console use separate notification jobs in the companion PRs. The shared `deploy-ecs.yml` and `deploy-s3-cloudfront.yml` workflows use the same pattern: a separate `notify` job with `contents: read`, `pull-requests: read` and `deployments: read`, fed by the actual deploy job's result, the commit resolved once in `setup` (and checked out by the deploy job) and that checkout's package.json version. Jira is reported only for production deploys of the triggering commit (`github.sha`), because GitHub records that commit on the environment deployment the ticket range is computed from; a manual deploy of another branch still notifies Slack but skips Jira.

A called workflow cannot request more token permissions than its caller grants, and GitHub rejects the whole run at startup otherwise. Callers of the shared deploy workflows must therefore grant the two extra read permissions, for example:

```yaml
permissions:
  id-token: write
  contents: read
  pull-requests: read
  deployments: read
```

Granting them before the shared change lands is harmless, so update callers (on every branch that deploys, including the production branch) first. `deploy-ecs.yml` callers use `secrets: inherit`, which already forwards the org secrets `JIRA_RELEASE_WEBHOOK_URL`, `JIRA_RELEASE_WEBHOOK_SECRET`, `ATLASSIAN_RELEASE_EMAIL` and `ATLASSIAN_RELEASE_TOKEN`; `deploy-s3-cloudfront.yml` declares them as optional secrets, so a caller that forwards secrets explicitly must add them. Both shared workflows pass the Jira webhook and the Release bot pair only for production deploys of the triggering commit, so these services also get Jira releases and Engineering › Release notes pages.

## Marking Jira tickets as released

GitHub for Jira only links a production deployment to tickets it finds in roughly the first ~100 commits since the previous deployment (observed, not documented). Weekly releases are routinely 100–300+ commits, so most shipped tickets never show as deployed. The notification action can instead send Jira the exact list of tickets a production deploy shipped.

### Which tickets count

A ticket counts as shipped by a change only if:

- its key is in the **branch name**, for example `SF-4401-gridspot-image-lost` or `feat/SF-12-export`, or
- a line in the PR description or a commit message **starts with "Closes"**: `Closes SF-123`, `Closes: SF-1, SF-2 and SF-3`, `* Closes SF-123` or `Closes [SF-123](https://servefirst.atlassian.net/browse/SF-123)`. `Closed` also works. "…it closes SF-1" in the middle of a sentence does not count. For a squash merge, only the final squash message is read, so keep the Closes line in it (GitHub's default squash message already includes the commit messages).

Mentions anywhere else never count: PR titles, "Depends on SF-9", "Follow-up to SF-8", or a key in passing text. So a branch without a key, such as `csat-sms-step-1`, needs a `Closes SF-…` line or its ticket is not moved. A hotfix with a fix commit that says `Closes SF-…` (or that comes from a ticket branch) reports it too. A "Closes" line in the release or hotfix PR description itself also counts, which helps for direct commits. The release notes use the same rule for their ticket links. They cover only this release PR's range, so after a skipped deploy Jira can be told about more tickets than the notes list.

### What is sent, and when

Only on a **successful production** deploy, the action rebuilds the list from GitHub at deploy time. Each commit is matched to its PR with GitHub's commit-to-PR lookup, so merge, squash and rebase merges all work. Lookups are batched 100 commits per GraphQL request (a typical release takes about 10 API calls in total), and the default job token is enough. Editing the generated notes block does not change which tickets are reported.

- **Range:** from the previous successful production deployment recorded in GitHub to the deployed commit. A release that merged but never deployed is then still reported by the next deploy that ships it. If there is no earlier production deployment at all, only this release PR's changes are reported, with a warning. If deployments can't be read (the job lacks `deployments: read`), nothing is sent and the step fails so it is visible.
- **Reverts:** a revert never reports a ticket, and every ticket on what it reverts is left out, even if another change also closes it. A revert of a revert also leaves the ticket out. When unsure, a ticket is left out rather than closed; move those by hand.
- **Rollbacks and redeploys:** deploying an older version, or a commit that already reached production, reports nothing, and so does a deploy whose history doesn't include the previous one.
- **Payload:** ticket keys in batches of 50. `releaseType` is `"hotfix"` for tickets that came through a `hotfix/*` PR into main (its branch, its `Closes` lines, its fix commits and PRs merged into it) and `"release"` for everything else. It is decided per ticket, not per deploy, so the two are posted as separate requests: a hotfix that also ships an earlier release that never deployed reports that release's tickets as `"release"`, and a release that ships an undeployed hotfix reports the hotfix's tickets as `"hotfix"`.

```json
{"issues": ["SF-4300", "SF-4401"], "data": {"repository": "servefirstcx/sf-api", "version": "4.25.0", "notesUrl": "https://github.com/servefirstcx/sf-api/releases/tag/v4.25.0", "releaseType": "release"}}
```

Nothing is validated or sent for staging, dev or failed deploys. GitHub holds only the webhook URL and secret, which can do nothing except trigger that one rule. It holds no Jira user credential. What happens to the tickets is defined, and visible, in Jira.

### Jira rule (SF project)

1. Trigger: *Incoming webhook*, "Issues provided in the webhook HTTP POST body". Copy the URL and secret.
2. Condition (JQL): `project = SF AND issuetype != Epic AND status in ("Dev Complete"{{#if(equals(webhookData.releaseType, "hotfix"))}}, "Ready for Dev", "In Progress"{{/}})`. Normal releases move only tickets the team marked Dev Complete. **Hotfix tickets** (`releaseType: "hotfix"`, see Payload above) also move Ready for Dev and In Progress tickets, because a hotfix ticket rarely reaches Dev Complete: the `hotfix/x.y.z` branch carries no ticket key, so the branch and merge rules never see it, and a hotfix only reports tickets someone explicitly linked with `Closes`. Other projects and epics are always ignored.
3. Action: transition to *Done (In Production)*.
4. Action: comment `Released to production in {{webhookData.repository}} v{{webhookData.version}}: {{webhookData.notesUrl}}` (Jira exposes the POST body's `data` fields directly on `webhookData`; `webhookData.data.*` renders empty).

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

Slack and Jira are independent: either can be configured alone, and a failure in one does not skip the other. Either failure still fails the (non-blocking) notification step so it is visible. If a batch fails, the error says how many tickets were already sent. Rerunning only the failed notification job resends all of them, and the Dev Complete condition skips tickets that already moved. Redeploying the same commit (a new deployment) reports nothing, because that commit already reached production.

Atlassian's endpoint can return HTTP 200 even when the secret is wrong or the rule is disabled, so the log says "webhook returned success", not "updated". Check the rule's audit log after the first real deploy.

Use `DRY_RUN=true` to print the tickets a production deploy would report without sending anything.

## Jira releases and Confluence release notes

On a successful production deploy, the notification action can also publish the facts of the release: a Jira release with fix versions, and a Confluence page under **Engineering › Release notes**. This is the facts layer. A separate weekly agent reads it and writes the narrative. Nothing here calls an AI model or writes prose.

It is off until `atlassian-email` and `atlassian-api-token` are passed. It runs after the Jira webhook step and uses the same shipped-ticket computation: the same range, the same ticket rule and the same revert handling (see [Which tickets count](#which-tickets-count)). If that computation fails, nothing is published.

### What gets created

- **Jira release** (project version) in `SF`, named `<repository> <version>`, for example `sf-api 4.26.0` (the repository name without the owner). It is marked released. The release date is the UTC date GitHub recorded the production deployment (the notification time if there is no record). The description is one line with a link to the Confluence page.
- **Fix version:** that release is added to every shipped ticket in `SF`. It is added alongside existing fix versions, without notification emails. Tickets in other projects, and keys Jira doesn't return (missing, or not visible to the account), are skipped with a warning.
- **Confluence pages** in space `Eng`:

```text
Release notes                    existing root page, created by hand
└── sf-api release notes         one per repository, created on its first deploy; lists its child pages
    ├── sf-api 4.26.0            one per deployed version
    └── sf-api 4.25.0
```

The version page holds only facts:

- **Details:** repository, version, deployed at (UTC), deployed commit, release or hotfix PR, GitHub release, previous production commit and the compare range.
- **Shipped without a ticket:** only when there are any. PRs with no ticket (no key in the branch name, no "Closes" line) and commits that reached production without a PR and name no ticket. The Details table also shows "Pull requests: N (X linked to tickets, Y without)", and how many commits had no PR.
- **Tickets shipped:** key, summary and type. There's no status column: the Jira rule moves these tickets at the same moment, so a snapshot would be stale on arrival (check Jira for live status). Keys Jira doesn't return are listed as "Not found in Jira". Requests send `Accept-Language: en-US`, because without it the gateway returned translated issue-type names for the service account.
- **Pull requests:** number, title, author, merged date and the shipped tickets each one closes. Sync PRs, release/hotfix PRs, reverts and reverted PRs are left out.
- **Commits without a pull request:** only when there are any. Commits in the deployed range that no PR covers, for example a fix pushed straight to a hotfix branch. Version bumps, release and sync merges, other merge commits and reverts are excluded.
- **Left out (reverted):** tickets and PRs left out because of reverts.

Every value is escaped, and links are built only from validated parts.

**Labels** on each version page: `release-notes` and `repo-<repository>`, for example `repo-sf-api`. The label is lowercase, and characters other than letters, digits, `_` and `-` become `-`. A weekly summary agent can find the week's pages with CQL `label = "release-notes" AND space = "Eng" AND created >= now("-7d")`, or one repository's with `label = "repo-sf-api"`. In Jira, use `project = SF AND fixVersion = "sf-api 4.26.0"`.

### Order, reruns and failures

1. Compute the shipped tickets and PRs from GitHub.
2. Read the tickets from Jira, in one `/search/jql` request per 50 keys. JQL can reject the whole query when one key doesn't exist, so a rejected search is retried one ticket at a time.
3. Find or create the repository page under the root page.
4. Create the version page, or update it in place as a new page version. Add the labels.
5. Create the Jira release, or update it (released, date, description with the page link).
6. Add the fix version to the `SF` tickets that don't already have it.

Every step looks before it creates, so a rerun updates the same page and release and adds no duplicates. A concurrent run that creates something first is reused, and if it updates the version page between our read and write, the page is reread and the update retried (up to three tries). A redeploy of an already deployed commit, a rollback or a diverged deploy has no new range, so it publishes nothing and leaves the existing page as it was. Rerunning only the notification job republishes the same facts.

A failure names the step and HTTP status, for example `Confluence: create version page failed (HTTP 403)`. It never includes the token, the URL or a response body. As with Slack and the Jira webhook, it fails the (non-blocking) notification step and doesn't stop the other channels. If it fails partway, rerun the notification job. A missing root page fails with `Confluence: root page "Release notes" not found in space Eng; create it first`.

Page titles are unique across the space, so a page is only reused where it belongs: the repository page directly under the root page, and the version page directly under its repository page. If a page with that title exists anywhere else, for example a hand-written `sf-api 4.26.0` in another section, the step fails before touching that page with `Confluence: a page titled "sf-api 4.26.0" already exists outside "sf-api release notes"; rename or move it, then rerun`. Nothing outside the release tree is ever overwritten.

An existing Jira release with the same name that is **archived** fails with `Jira: release "sf-api 4.26.0" is archived; unarchive it in SF › Releases, then rerun`, before any ticket is edited. Jira can accept an edit that adds an archived version and then not apply it, so the step never relies on one.

Use `DRY_RUN=true` (with the two inputs set) to print the page path, labels, release name and the tickets that would get the fix version, without any Atlassian request. Set `CONFLUENCE_PAGE_FILE=/path/page.html` to also write the page body, without Jira summaries.

### Account, permissions and token

Use a dedicated account, not a person's, and create the root page **Release notes** in the `Eng` space by hand first.

- **Jira, project `SF`:** *Administer Projects*. Jira requires this, or *Administer Jira*, to create and update versions. Without it, Jira also ignores `notifyUsers=false` and watchers get an email for every fix-version edit. The account also needs *Browse Projects* and *Edit Issues*, which the project admin role normally has (check the permission scheme), and must be able to see the tickets if issue security is used.
- **Confluence, space `Eng`:** view the space and add pages, which covers editing the pages it creates and their labels. If the **Release notes** page has restrictions, add the account to them.

Requests use HTTP Basic auth (account email and API token) through the `api.atlassian.com/ex/{jira|confluence}/{cloudId}` gateway, so scoped API tokens work. The cloud ID defaults to ServeFirst's site (`atlassian-cloud-id`).

**ServeFirst setup:** the **Release bot** service account (Atlassian Administration → Directory → Service accounts) is in SF's *Administrators* project role (not a site-wide admin), and can view, add and edit pages in the Engineering space. Its API token (`github-release-publisher`, expires 2027-10-03) covers both apps with exactly these 25 granular scopes. Service-account tokens offer granular scopes only:

- **Jira (20):** `read:project:jira`, `read:project.property:jira`, `read:project.component:jira`, `read:project-category:jira`, `read:project-version:jira`, `write:project-version:jira`, `read:issue-type:jira`, `read:issue-type-hierarchy:jira`, `read:user:jira`, `read:application-role:jira`, `read:avatar:jira`, `read:group:jira`, `read:issue-details:jira`, `read:issue-meta:jira`, `read:audit-log:jira`, `read:field:jira`, `read:field.default-value:jira`, `read:field.option:jira`, `read:field-configuration:jira`, `write:issue:jira`.
- **Confluence (5):** `read:space:confluence`, `read:page:confluence`, `write:page:confluence`, `read:label:confluence`, `write:label:confluence`.

They are the union of the `x-atlassian-oauth2-scopes` for exactly the endpoints this code calls: get project; get, create and update versions; `POST /search/jql`; edit issue; v2 spaces and pages; and the v1 add-label endpoint. **Any new endpoint must be checked against this list.** For example, `GET /issue/{key}` needs five more scopes, which is why missing keys are searched one at a time instead. Rotate the token before it expires.

`atlassian-confluence-api-token` is only needed if Jira and Confluence use separate tokens. ServeFirst's single token covers both, so leave it unset.

Store them as organisation secrets visible to the application repositories: **`ATLASSIAN_RELEASE_EMAIL`**, **`ATLASSIAN_RELEASE_TOKEN`** (both already set at org level), plus **`ATLASSIAN_RELEASE_CONFLUENCE_TOKEN`** only if you split tokens per app.

### Wiring a repository

Pass the inputs to the notification step. The job needs `deployments: read`, as for the Jira webhook:

```yaml
    permissions:
      contents: read
      pull-requests: read
      deployments: read
    ...
        atlassian-email: ${{ secrets.ATLASSIAN_RELEASE_EMAIL }}
        atlassian-api-token: ${{ secrets.ATLASSIAN_RELEASE_TOKEN }}
        atlassian-confluence-api-token: ${{ secrets.ATLASSIAN_RELEASE_CONFLUENCE_TOKEN }}
        # Defaults: atlassian-cloud-id (ServeFirst), jira-project: SF, confluence-space: Eng, confluence-root-title: Release notes
```

The log shows the Confluence page URL and the Jira release name. With none of the three credential inputs set, the step logs that publishing was skipped. The email and main token are both required once either Atlassian input is set; the Confluence token is optional. An incomplete setup, for example only the Confluence token, fails visibly instead.

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
