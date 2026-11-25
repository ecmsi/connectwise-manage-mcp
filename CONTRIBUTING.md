# Contributing

Thank you for your interest in contributing! This project is maintained by [ECMSI](https://github.com/ecmsi). Run `npm run check` before opening a pull request; it is the same gate CI runs.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `npm ci`
4. Create a feature branch: `git checkout -b feature/your-feature`

## Development

```bash
npm run build       # Build the project
npm run test        # Run tests
npm run lint        # Run linter
npm run typecheck   # Type-check without emitting
```

## Pull Request Process

1. Ensure all tests pass and linting is clean
2. Update documentation if you're changing public APIs
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `chore:` for maintenance tasks
4. Open a pull request against the `main` branch

## Releasing (maintainers)

A release is a tag; the `release.yml` workflow does the rest.

1. On a branch, set the new version in `package.json`, `package-lock.json` (both entries),
   `src/mcp-server.ts` and the image tag in `docker-compose.yml`; `npm run version:check` lists any
   you missed. Pin the same version in `README.md` and `docs/DEPLOYMENT.md`, and date the
   `CHANGELOG.md` entry.
2. Open the pull request, let CI pass, merge it.
3. On the merge commit: `git tag -s vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
4. The workflow re-runs the gate on the tag, publishes `ghcr.io/ecmsi/connectwise-manage-mcp:X.Y.Z`
   for linux/amd64 and linux/arm64, and creates the GitHub Release with the image digest and the
   npm tarball. Do not create the release by hand; if the workflow fails, fix the cause and re-run it.

## Reporting Issues

- Use GitHub Issues
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version and OS

## Code Style

- TypeScript with strict mode
- ESM modules (`import`/`export`)
- Prefer `async`/`await` over Promise chains
- Follow existing patterns in the codebase

## License

By contributing, you agree that your contributions will be licensed under the same license as this project (Apache-2.0).
