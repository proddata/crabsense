# Releasing CrabSense

The root package is `@proddata/crabsense`. The `demo/` application is private and is not in the npm tarball. [Test](../.github/workflows/test.yml) runs on `main` and pull requests. [Publish](../.github/workflows/publish.yml) runs only for a `vMAJOR.MINOR.PATCH` tag whose version matches the root `package.json` and whose repository is `proddata/crabsense`. It runs the package and demo tests, builds the package, checks the tarball, and publishes through npm trusted publishing. The release job needs no npm token; npm adds provenance for a public repository and public package.

## First release (0.1.0)

The first npm publish must be done by a maintainer with npm access to the `@proddata` scope because npm can only configure a trusted publisher after the package exists. Publish the GitHub repository as `proddata/crabsense`, then from a clean checkout of the reviewed commit:

```sh
npm ci
npm test
npm run build
npm run verify:package
npm --prefix demo ci
npm run demo:test
npm run demo:build
npm login
npm publish --access public
```

Check `npm view @proddata/crabsense version` returns `0.1.0`. Do not push a `v0.1.0` tag after this manual publish; the workflow would attempt to publish the same immutable version again.

On npmjs.com, open the package's **Trusted Publisher** settings and add GitHub Actions with organization `proddata`, repository `crabsense`, and workflow filename `publish.yml`. Allow direct `npm publish`. The workflow has `id-token: write` for OIDC. Keep the repository URL in `package.json` aligned with the eventual GitHub repository, because npm checks it for trusted publishing.

## Later releases

From a clean `main` branch, create a release branch, bump the version without creating a tag yet, update the demo's local package lock, and run the checks. Merge the release through a pull request so the required `test` check runs. Tag the merged commit on `main`:

```sh
git switch -c release/next
npm version patch --no-git-tag-version
npm --prefix demo install --package-lock-only --ignore-scripts
npm ci
npm test
npm run build
npm run verify:package
npm --prefix demo ci
npm run demo:test
npm run demo:build
git add package.json package-lock.json demo/package-lock.json
git commit -m "Release $(node -p 'require("./package.json").version')"
git push -u origin HEAD
# Open a pull request and merge it after CI passes.
git switch main
git pull --ff-only
git tag "v$(node -p 'require("./package.json").version')"
git push origin "v$(node -p 'require("./package.json").version')"
```

Use the same steps with `minor` or `major` instead of `patch` when appropriate. The publish workflow rejects a tag that differs from the package version or points outside `main`, and npm rejects a version that has already been published.
