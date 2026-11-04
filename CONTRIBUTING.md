# Contributing

Thank you for looking. PLUT_OS is small on purpose; a change is welcome when it serves any project
that one owner works on with several AI tools, not one field's needs.

- **Before a change:** open an issue that says what is wrong or missing and how you would check it
  is fixed. A bug report with the steps to reproduce it is the most useful one.
- **The change:** one change per pull request, the smallest that does it. No new runtime dependency.
  Every line traces to the issue.
- **Before the pull request:** `npm install`, then `npm test` (every suite in
  `tools/run-all-tests.mjs`) and `node cli.mjs check` must pass on your tree. A change to an MCP tool's
  schema, an HTTP route or an approval rule says in the pull request who reviewed the contract change
  and what they found.
- **Licence:** contributions are accepted under the Apache License 2.0 (section 5 of `LICENSE`).
