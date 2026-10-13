# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

> **Status:** Swoop is applying to the SignPath Foundation's free program for open-source projects. Until the application is approved, releases are **not signed yet**. This page describes how signing works once it is.

## What gets signed

- The installer, `Swoop-Setup-x64.exe`, and the programs it installs: `Swoop.exe` and `swoop-host.exe` (the browser connector).
- Only files built from this repository's source code by the public [Release workflow](https://github.com/farzad006/swoop-download-manager/actions/workflows/release.yml) on GitHub Actions. Nothing built on a personal computer is ever signed.
- Third-party parts that ship unchanged inside the installer, such as the NSIS installer engine, aren't signed by this project.
- Every release is approved by hand by an approver before it's signed.

## Team roles

| Role | People |
|---|---|
| Committers and reviewers | [Project members](https://github.com/farzad006/swoop-download-manager/graphs/contributors): [@farzad006](https://github.com/farzad006) |
| Approvers | [Owner](https://github.com/farzad006): [@farzad006](https://github.com/farzad006) |

Changes from anyone outside the team arrive as pull requests and are reviewed by a reviewer before they're merged. All team members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

See [PRIVACY.md](PRIVACY.md). In short, Swoop has no accounts, ads, analytics or telemetry. It only connects to the websites you download from, plus one optional daily check for a newer version of the video downloader (yt-dlp), which you can turn off in Settings → Videos.

## Installing and uninstalling

Swoop installs for the current user only. It adds registry entries (for that user) so that browsers with the Swoop extension can talk to it. The extension itself is only added to a browser when you choose to. Uninstalling from Windows Settings → Apps removes those entries. Starting with Windows is off unless you turn it on.

## Reporting a problem

If you find a signed file that you think shouldn't be, or anything that looks wrong, please [open an issue](https://github.com/farzad006/swoop-download-manager/issues) or email farzad006@gmail.com.
