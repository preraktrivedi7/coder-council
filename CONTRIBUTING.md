# Contributing to Coder Council

Thanks for helping make multi-model coding easier to trust and easier to use.

## Before opening a pull request

1. Search existing issues and discussions.
2. Keep the change focused and explain the user problem it solves.
3. Add or update tests for behavior changes.
4. Run the full local gate:

   ```bash
   npm install
   npm --prefix extensions/vscode install
   npm test
   npm run test:acceptance
   npm run test:vscode
   npm run check:vscode
   npm run check:secrets
   npm run check:public
   ```

5. Update user documentation when commands, setup, provider behavior, or safety
   boundaries change.

Normal tests must not call paid or live providers. Keep live smoke tests behind an
explicit command and never add credentials to fixtures, logs, issues, or commits.

## Design rules

- Candidate answers remain isolated until comparison.
- Competing candidates receive materially equivalent task evidence.
- Only one implementation agent may mutate a working tree at a time.
- Reviewers and arbiters are read-only by default.
- Provider tooling owns authentication; Coder Council does not build a credential
  vault or copy provider tokens.
- Paid inference, telemetry, and public listeners stay off by default.
- Evidence and reproducible tests outrank model votes.
- Public model/token/cost metadata remains `null` when the provider does not report
  it; do not invent estimates.

## Pull requests

Use an imperative title, describe the behavior before and after, and include the
commands you ran. Screenshots or a short recording help for VS Code interface
changes. By submitting a contribution, you agree that it is licensed under the
project's Apache-2.0 license.
