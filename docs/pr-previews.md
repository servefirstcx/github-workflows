# PR previews (`pr-preview.yml`)

Every pull request into `stage` gets its own copy of the web app, admin app or survey site:

| App | Repo | Preview URL for PR N |
|-----|------|----------------------|
| `app` | sf-react-app | `https://app-pr-N.preview.servefirst.co.uk` |
| `admin` | sf-admin | `https://admin-pr-N.preview.servefirst.co.uk` |
| `front` | front-ratings | `https://front-pr-N.preview.servefirst.co.uk` |

Previews talk to the **stage API, with stage data**. The PR gets one comment with the
link and the commit it shows, edited in place on every push. When the PR closes
or merges, the preview is deleted and the comment says so. Files left behind expire
after 14 days anyway (bucket lifecycle).

## What the workflow does

Each run makes the preview match the PR as it is right now, instead of acting on the event
that started it:

- One run at a time per repo + PR + app (job-level concurrency group, never cancelled), so
  no two runs write the folder or the comment at once.
- Holding the group, the run reads the PR and acts. **Closed:** delete
  `s3://preview.servefirst.co.uk/<app>/pr-<N>/`, invalidate it and mark the comment removed.
  **Open:** publish the build of the PR's current head commit (hashed `assets/` and `static/`
  with a long cache, `index.html` last with `no-cache`, `--delete` so the folder holds exactly
  that build), invalidate `/<app>/pr-<N>/*` and point the comment at that commit. The build
  comes from the newest run of the caller workflow for that commit that still has the
  artifact, so a late run for an older commit publishes the newer one, never its own.
  **Open, no build for the head yet:** leave the preview as it is.
- Then it reads the PR again and repeats until a read agrees with what it last did, so a change
  mid-run, or a stale API answer that GitHub corrects within the pause between reads, is fixed
  in the same run. If the PR keeps changing for 5 rounds the run fails; rerun it. An API or
  download error also fails the run (it is never read as "closed" or "no build").
- GitHub keeps only the newest pending run in a group and drops older pending ones. A run
  only joins the group after its build uploaded the artifact, so the surviving run can still
  publish a dropped run's build.
- Limits, by design: a commit whose build fails keeps the previous preview (the comment names
  the commit that is actually live); a build whose artifact has expired (the caller's
  `retention-days`) can't be republished by a later run until the PR gets a new build, for
  example after a reopen; old tabs may briefly request files of the previous build after a
  publish (stage only, not an atomic switch).
- Fork PRs and anything but `pull_request` events skip the job, so the deploy role is never assumed.

Fixed in the workflow (no secrets or repo variables needed): role
`arn:aws:iam::068531097348:role/stage-github-actions-preview` (trusts only
`sf-react-app`, `sf-admin` and `front-ratings` `pull_request` runs), bucket `preview.servefirst.co.uk`,
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
          retention-days: 3

  publish:
    needs: build
    uses: servefirstcx/github-workflows/.github/workflows/pr-preview.yml@main
    permissions:
      id-token: write
      contents: read
      pull-requests: write
      actions: read # to fetch the head commit's build from another run
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
      actions: read
    with:
      app_name: admin # sf-react-app: app
      artifact_name: preview-site # a cleanup that finds the PR reopened publishes its head
      action: cleanup
```

Notes:

- Upload the build directory itself as the artifact: `index.html` must be at its root.
- Use the same `artifact_name` for publish and cleanup: it is how a run finds another run's build.
- Don't add a `concurrency` group with `cancel-in-progress` around the publish or cleanup
  jobs in the caller: cancelling them is what the shared job's design avoids.
- front-ratings keeps its stage build settings in the `staging` environment's `BUILD_ENV_VARS`
  secret, not in a committed env file, so its build job runs with
  `environment: { name: staging, deployment: false }` and parses that secret the same way
  `deploy-s3-cloudfront.yml` does (no staging deployment is recorded on the PR). Its
  `isPlatformHost` (`src/helpers/apiBase.js`) also lists `front-pr-N.preview.servefirst.co.uk`,
  otherwise the build would call the same-origin `/api` used on customer custom domains, which
  the preview distribution does not route.
