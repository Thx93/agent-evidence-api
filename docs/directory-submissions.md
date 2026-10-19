# Directory submissions, 2026-10-19

Attempted via the DRsubmission target list (Mimimiraclez/DRsubmission, a fork of
Backlink Pilot). Its own README is explicit that a filled form is not a listing and
that it verified **zero** live pages, so treat every row below as *submitted, unverified*
unless a confirmation was actually received.

## What the audit found first

Of 49 AI-directory targets in the list, a sample of 14 broke down as:

| outcome | count |
| --- | --- |
| Cloudflare Turnstile / reCAPTCHA wall | 8 |
| dead or blocked (0 fields, HTTP 522) | 2 |
| usable form | 4 |

The captcha wall is the real blocker: the submit control stays disabled until the
token resolves, so those sites cannot be submitted to programmatically at all.

## Attempted (15 sites with a usable form)

| site | fields filled | submit clicked | observed |
| --- | --- | --- | --- |
| Apps and Websites | 0 | no | unknown - check |
| DropYourAI | 8 | no | failed |
| Insidr.ai | 3 | no | failed |
| Fivetaco | 1 | yes | unknown - check |
| AI Startups | 1 | yes | likely accepted |
| StartupTracker | 2 | yes | unknown - check |
| AlphaDigits | 1 | no | failed |
| AINave | 1 | no | likely accepted |
| VerySaaS | 2 | yes | unknown - check |
| ListedAI | 13 | yes | likely accepted |
| Daily Zaps Picks | 6 | yes | unknown - check |
| Businesstoolvault | 6 | yes | likely accepted |
| InfraBase.ai | 5 | yes | likely accepted |
| ToolAssistant | 3 | yes | likely accepted |
| Landing Page Tools | 6 | yes | likely accepted |

## Confirmed by email

- **ListedAI** — "Thanks for submitting your AI tool!" received at 11:09 UTC.
- **mcpservers.org** — both MCP servers were approved on 2026-10-18 and the
  evidence listing was verified live in a browser:
  <https://mcpservers.org/servers/thx93/agent-evidence-api>. Badges added to both
  READMEs.

## Not done, and why

The remaining ~30 AI targets are captcha-walled, dead, or require an account. Several
of the 15 above filled only one or two fields, meaning the generic adapter did not
recognise their form - those submissions are probably incomplete and should be
re-done by hand.
