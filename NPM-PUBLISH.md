# Publishing to npm

## First-time Setup

1. **Create npm account** (if needed): https://www.npmjs.com/signup

2. **Login from CLI**:
   ```bash
   npm login
   # Follow prompts: username, password, email, OTP
   ```

3. **Verify auth**:
   ```bash
   npm whoami
   # Should show your npm username
   ```

## Publishing

```bash
cd /path/to/openclaw-tool-resolver

# Dry run first — see what would be published
npm pack --dry-run

# Publish (package.json already has "publishConfig": {"access": "public"})
npm publish
```

The `"files"` field in `package.json` controls what gets included:
- `index.js` — the plugin
- `openclaw.plugin.json` — plugin metadata
- `benchmark/` — benchmark suite

## Version Bumping

```bash
# Patch (0.2.0 → 0.2.1): bug fixes
npm version patch

# Minor (0.2.0 → 0.3.0): new features, benchmark expansion
npm version minor

# Major (0.2.0 → 1.0.0): breaking changes
npm version major

# Then publish
npm publish
```

## GitHub Actions (automated publishing)

To auto-publish on GitHub releases, add this workflow:

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Setup required:**
1. Generate an npm automation token: https://www.npmjs.com/settings/tokens
2. Add it as `NPM_TOKEN` in GitHub repo secrets

## GitHub Sponsors (for donations/tips)

The repo already has `.github/FUNDING.yml` pointing to `github: stroupaloop`.

**To activate GitHub Sponsors:**
1. Go to https://github.com/sponsors/accounts
2. Set up a sponsorship profile (bank account, tax info)
3. Once approved, the "Sponsor" button appears on the repo

**Alternative: Ko-fi or Buy Me a Coffee**
Add to `.github/FUNDING.yml`:
```yaml
github: stroupaloop
ko_fi: your_kofi_username
```
