# Security policy

## Supported versions

Only the latest published beta is supported while the project is below 1.0.
Plugin updates are accepted only from the HTTPS URL declared in the distributed
script. Review the GitHub release and checksum before confirming an update.

## Reporting a vulnerability

Do not open a public issue containing provider keys, session cookies, database
contents, private prompts, or exploit details. Open a private GitHub security
advisory for this repository instead.

## Credential boundary

The plugin accepts a non-secret `credential_ref`. Provider secrets belong in
administrator-controlled server environment variables and must not be placed
in plugin arguments, registry JSON, job metadata, event journals, screenshots,
or bug reports.
