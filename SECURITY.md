# Security

PLUT_OS is a local app: the dashboard listens on 127.0.0.1 only and refuses requests that are not
from the same computer, and the MCP server talks to the AI client over stdio.

To report a security problem, use GitHub's private vulnerability reporting ("Report a
vulnerability" on this repository's Security tab). Please do not open a public issue for it. Say
what you saw, the version (`package.json`), the operating system, and the steps to reproduce it.
