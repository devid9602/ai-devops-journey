# Security

This is a reference/portfolio project. If you spot a security issue, please open a private security advisory on GitHub rather than a public issue.

Design notes: no long-lived AWS keys (GitHub OIDC only), secrets only in AWS Secrets Manager, no secrets in the repo (gitleaks runs in CI).
