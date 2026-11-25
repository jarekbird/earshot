# Security

## Report a hole privately

Do not open a public issue for a security hole. Use GitHub's private report instead: on the repository's
[Security tab](https://github.com/jarekbird/earshot/security), choose **Report a vulnerability**. Only the maintainer
sees it.

Say what you did, what happened, and the version you pinned. A short test that shows it is the best report there is.

One person maintains Earshot, so an answer can take a few days. A fix ships as the next version, and the
[changelog](CHANGELOG.md) names it. Only the newest version gets fixes.

## What matters most

- **The relay.** It holds the developer's key. A report that the key, or a call made with it, can reach any address
  but the upstream the developer named, or that a caller gets past the secret or the list of models, matters most.
- **Private targets.** A target an app marks private must never leave the device (rule E6).
- **The hosts an app lists.** The framework connects only to those (rule E2).
- **The store check.** `earshot-check` must not pass a build that holds a URL outside the manifest's whitelist.

## Known, and not a hole

The relay cannot tell one user from another. Anyone who finds the address of a relay with no secret can spend the
developer's credit on the three calls of a hold, up to the spending limit set on the key, and whoever holds a
relay's secret can use its calls and its live speech without a count. A call or a live line that gets through a
relay with a secret, without saying that secret, is a hole: report it. The [README](README.md#the-relay) says so, and says to set that limit.
