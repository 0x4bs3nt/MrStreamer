// Main and the catalogue worker each import this first: threads have separate globals, and
// provider and TMDB clients capture fetch when created. undici's install() supplies fetch and
// matching Request, Response, Headers and FormData, plus the unused WebSocket and EventSource.
// An existing global dispatcher is retained; this bootstrap sets no transport options.
// Electron 44.9.3 bundles Node 24.22.0 with undici 7.29.1; the dependency supplies 7.30.1's
// fetch correction for GHSA-xjj6-f33q-929c. process.versions.undici still names the bundled copy.
// Remove this and the dependency once a supported Electron ships the fixed fetch.
import { install } from "undici";

install();
