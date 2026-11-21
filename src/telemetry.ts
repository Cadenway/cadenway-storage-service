import { startTelemetry } from '@cadenway/nest-common/telemetry';

// Preloaded before the application: `node --max-old-space-size=160 --import
// @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js`. The register entry point
// installs the module hooks first; the instrumentations of HTTP, Express, pg and fetch must then be
// registered before anything imports those modules, so this file imports nothing else. Traces and
// metrics leave as OTLP over HTTP to OTEL_EXPORTER_OTLP_ENDPOINT; unset, spans are still created
// (trace ids in the logs, `traceparent` propagated over HTTP and NATS) and nothing leaves the
// process.
// The exporter also replaces these prefixes wherever they appear in recorded URLs, including
// requests whose path includes a bucket or an endpoint prefix before the object key.
startTelemetry({
  service: 'storage-service',
  sensitiveHttpPathPrefixes: [
    '/org/',
    '/intake/',
    '/profile-media/',
    '/internal/v1/avatars/',
    '/internal/v1/organization/logo-assets/',
    '/internal/v1/profile-media-uploads/',
  ],
});
