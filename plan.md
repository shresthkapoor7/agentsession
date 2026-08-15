# Shared session backend plan

## Decision

Use Python with FastAPI on Railway for the backend control plane.

FastAPI will handle authorization, password verification, rate limits, share metadata, expiry, revocation, and Storage signing. The Next.js app remains the frontend, local parser, and share viewer.

Supabase will provide Postgres and private object Storage. The browser will never receive a Supabase service-role key and will not query share tables directly.

## Publishing flow

1. The browser parses the selected Codex or Claude session locally.
2. Before publishing, the browser shows a warning that transcripts may contain secrets, local paths, source code, and tool output.
3. The browser removes known local-path and credential patterns, then shows the user a publish review.
4. The browser normalizes the transcript into the current viewer format, compresses it, and encrypts it locally with a fresh random content key.
5. The browser sends a publish-intent request to FastAPI with safe metadata only.
6. FastAPI checks the rate limit, size policy, expiry policy, and requested visibility.
7. FastAPI creates a random Storage object path and returns a short-lived, one-object upload URL.
8. The browser uploads the encrypted blob directly to a private Supabase Storage bucket.
9. The browser calls a completion endpoint. FastAPI marks the share as ready and returns the public link and a separate management link.

The content key is stored in the URL fragment, for example `#k=...`. URL fragments are not sent to Railway or Supabase.

## Share modes

### Public

- Anyone with the full unguessable share link can view the transcript.
- The link token is a random 256-bit capability, not a sequential database ID.
- Railway verifies the token and returns a short-lived signed download URL for the encrypted blob.

### Password protected

- The publisher supplies a password during publishing.
- FastAPI stores only an Argon2id password hash.
- The viewer sees a password prompt after opening the link.
- A correct password permits a short-lived encrypted-blob download.
- Password attempts are rate-limited by both share and IP address.

## Publisher identity and management

- Publishing requires a display name. It is public, length-limited, normalized, and escaped.
- No Google sign-in or account is required.
- A publish creates a separate private management capability link.
- The management link can revoke a share before expiry but cannot extend its expiry.
- If the management link is lost, it cannot be recovered in the no-account model.

## Expiry and deletion

- Every share expires exactly 21 days after creation. The client cannot choose another duration.
- After expiry, FastAPI refuses new metadata, password-unlock, and signed-download requests.
- A Railway scheduled worker deletes the Storage object and share metadata shortly after expiry.
- Revocation uses the same deletion path immediately.
- Short-lived signed URLs may remain usable until their brief lifetime ends. Use a 60-second lifetime.

## Security boundaries

- Store transcript ciphertext in a private Supabase Storage bucket only.
- Store minimal metadata in Postgres. Never store plaintext transcript content in database rows.
- Keep the Supabase service-role key only in Railway environment variables.
- Do not expose share tables through Supabase client APIs or permissive RLS policies.
- Database rows store hashes of view and management capabilities rather than raw tokens.
- Generate Storage paths on the backend. Never accept a client-provided object path.
- Uploads are limited to one generated object, have a short expiry, and do not permit overwrite.
- Do not log request bodies, passwords, decrypted content, content keys, or capability URLs.
- Add restrictive CORS for the production frontend domain and development localhost only.

## Abuse prevention

Initial limits should be conservative and configurable:

- Publish intent: 5 per IP per hour.
- Password attempts: 10 per IP and share per 15 minutes.
- Share metadata and download requests: 60 per IP per minute.
- Maximum compressed encrypted upload size: choose before launch, initially 25 MB.
- Per-IP daily uploaded-byte allowance: choose before launch.
- Add Cloudflare Turnstile only after repeated failed attempts or suspicious publish volume.

Rate limits are abuse controls, not authentication. A caller can replay browser requests with Postman, but FastAPI must give that caller no more permission than the browser receives.

## Data model

### `shares`

- `id`: internal UUID
- `view_token_hash`: hash of the public capability
- `manage_token_hash`: hash of the private management capability
- `display_name`
- `provider`: `codex` or `claude`
- `visibility`: `public` or `password`
- `password_hash`: nullable Argon2id hash
- `storage_path`: private generated path
- `status`: `uploading`, `ready`, `revoked`, or `expired`
- `created_at`, `expires_at`, `deleted_at`
- `schema_version`
- safe aggregate metrics: processed, cached, generated, reasoning tokens, tasks, tools, patches, model summary, compressed byte count

### `publish_intents`

- Internal upload state with an expiry shorter than the signed upload URL.
- Used to remove orphaned uploads that were never completed.

### Future `leaderboard_aggregates`

- Contains only approved public numbers, display name, anonymous publisher key, and rank.
- Never joins to or exposes raw share rows, Storage paths, links, passwords, or transcript content.
- Ranking remains intentionally lightweight until a stronger identity system is desired.

## FastAPI endpoints

- `POST /v1/publish-intents`
- `POST /v1/publish-intents/{id}/complete`
- `GET /v1/shares/{view_token}`
- `POST /v1/shares/{view_token}/unlock`
- `POST /v1/manage/{manage_token}/revoke`
- `POST /v1/internal/cleanup-expired`

The cleanup endpoint is internal-only and invoked by a Railway scheduled job.

## Implementation phases

1. Create the FastAPI project, Railway deployment, environment configuration, health endpoint, and database migrations.
2. Add private Storage bucket policies, share and publish-intent tables, and server-side capability hashing.
3. Build publish intent, direct encrypted upload, completion, and management-link delivery.
4. Add public and password-protected viewer retrieval with strict rate limits.
5. Add client-side publish review, redaction warnings, compression, encryption, and decrypting share view.
6. Add 21-day cleanup, revocation, orphan-upload cleanup, metrics, and audit-safe operational logging.
7. Add later leaderboard aggregation as a separate read model.

## Required tests

- Public and password share access rules.
- Invalid, expired, revoked, and reused capabilities.
- Password hashing and rate-limit behavior.
- Generated object paths and rejected client-provided paths.
- Upload size and content-type limits.
- 21-day expiry and cleanup deletion.
- No direct Supabase table or Storage access with frontend credentials.
- Transcript decrypt and schema-version compatibility in the share viewer.
