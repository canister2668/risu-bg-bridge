# Changelog

## 0.9.0-beta.1

- Added an importable RisuAI API v3 provider plugin with durable host-job
  polling, cancellation, result reads, aux ACKs, and a foreground fallback.
- Added the HaejeokRisuAI b6704 `backgroundModels` host bridge and durable job
  patch.
- Added the locked PocketRisu 1.10.0 adapter/build kit.
- Added the SQLite durable common engine, typed event journal, restart
  recovery, delivery fencing, tool replay policies, and resumable finalization.
- Added 118 unit, persistence, fault-injection, packaging, and compatibility
  tests in the release environment. Cache-dependent PocketRisu tests skip in
  public clones until the locally verified source snapshot is reconstructed.

Known beta boundary: browser E2E and real-provider generation are not included
in the automated verification claim.
