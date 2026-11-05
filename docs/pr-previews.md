# PR previews (`pr-preview.yml`)

Every pull request into `stage` gets its own copy of the web app or admin app:

| App | Repo | Preview URL for PR N |
|-----|------|----------------------|
| `app` | sf-react-app | `https://app-pr-N.preview.servefirst.co.uk` |
| `admin` | sf-admin | `https://admin-pr-N.preview.servefirst.co.uk` |

Previews talk to the **stage API, with stage data**. The PR gets one comment with the
link and the commit it was built from, edited in place on every push. When the PR closes
or merges, the preview is deleted and the comment says so. Files left behind expire
after 14 days anyway (bucket lifecycle).

## What the workflow does

- `action: publish` downloads the build artifact, checks the PR is still open at this
  commit (otherwise a newer run publishes instead), uploads it to
  `s3://preview.servefirst.co.uk/<app>/pr-<N>/` (hashed `assets/` and `static/` files
  with a long cache, `index.html` last with `no-cache`), invalidates `/<app>/pr-<N>/*`
  and updates the comment.
- `action: cleanup` deletes the folder, invalidates it and edits the comment.
- Fork PRs and non-PR events skip the job, so the deploy role is never assumed.
- One run per repo + PR + app at a time: a new publish cancels a running one (newest
  push wins); cleanup is never cancelled by a publish and waits for a running one.

Fixed in the workflow (no secrets or repo variables needed): role
`arn:aws:iam::068531097348:role/stage-github-actions-preview` (trusts only
`sf-react-app` and `sf-admin` `pull_request` runs), bucket `preview.servefirst.co.uk`,
region `eu-west-2`, and the CloudFront distribution found by its alias
`*.preview.servefirst.co.uk`.

## Caller wiring

Add `.github/workflows/pr-preview.yml` to the app repo. Example for sf-admin; for
sf-react-app use `app_name: app` and `path: build`:

```yaml
name: PR preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
    branches: [stage]

permissions:
  contents: read

jobs:
  build:
    if: github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }} # the commit the comment names
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run build # with the stage build settings, so the preview talks to the stage API
      - uses: actions/upload-artifact@v4
        with:
          name: preview-site
          path: dist # sf-react-app: build
          retention-days: 1

  publish:
    needs: build
    uses: servefirstcx/github-workflows/.github/workflows/pr-preview.yml@main
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    with:
      app_name: admin # sf-react-app: app
      artifact_name: preview-site
      action: publish

  cleanup:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    uses: servefirstcx/github-workflows/.github/workflows/pr-preview.yml@main
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    with:
      app_name: admin # sf-react-app: app
      action: cleanup
```

Notes:

- Upload the build directory itself as the artifact: `index.html` must be at its root.
- Don't add a workflow-level `concurrency` group named `pr-preview-...` in the caller;
  the shared job already uses one, and a clash would deadlock.
