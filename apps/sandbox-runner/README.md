# Sandbox runner transport seam

This package contains protocol validation and a disabled-by-default HTTPS
transport seam for a future separately deployed runner. The transport accepts
an already formed, signed protocol request and validates the shape of the
authenticated response. It does not create capabilities, execute firmware,
admit requests, verify response signatures, or persist run state. The worker
does not call it.

`createRunnerTransport()` is inert unless `enabled: true` is passed explicitly.
When enabled, the endpoint must use HTTPS, redirects are rejected, credentials
are omitted, request and response sizes are bounded, and calls have a bounded
timeout. These controls are transport safeguards, not proof of runner
isolation.

Execution remains unavailable until deployment provisions and approves a
separate isolated Linux runner, reviewed immutable runtime images, signing and
verification keys, shared replay storage, approved execution profiles, and an
operator-owned lifecycle for updates and incidents. Docker Desktop on a rootful
host does not satisfy the uploaded-firmware isolation gate. No local setting
should enable this seam as a substitute for those deployment controls.
