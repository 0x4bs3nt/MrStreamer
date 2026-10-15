# Mr. Streamer for iOS

React Native on Hermes (Expo SDK 58), building toward the desktop app's features. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node, and brings its
own native adapters: the Keychain for secrets now, and a player, storage and networking as they
are proved. Nothing of it is in the desktop's install, build or packages.

## Its own install

`apps/ios` is left out of the root workspace and has its own `pnpm-workspace.yaml` and lockfile,
so React Native never changes what the desktop installs. The shared packages are linked as source;
`metro.config.cjs` resolves their imports (arktype, effect) from this app, one copy of each, so
keep those two at the versions the root lockfile holds.

```sh
cd apps/ios
pnpm install --frozen-lockfile
../../node_modules/.bin/tsc --noEmit -p .
```

Expo SDK 58 is a prerelease (React Native 0.88 release candidate). It is the first SDK whose
template adopts the UIScene life cycle, without which an app built with the iOS 27 SDK stops at
launch. `patches/` adds `URL.parse` and `URL.canParse` to React Native's type of the global `URL`:
at runtime Expo installs a WHATWG `URL` that has both.

## What Hermes lacks

The shared rules use some JavaScript that Hermes on iOS doesn't have or gets wrong.
`src/polyfills.ts` installs what the runtime proof showed missing, before anything else loads:
`Intl.Locale`, `PluralRules`, `ListFormat`, `DisplayNames` and `NumberFormat` (FormatJS, with the
interface languages' data) and `Array.prototype.toSorted` and `toReversed` (core-js). Still
missing and not polyfilled: `Buffer`, so `core/guide/xmltv` can't load, and `crypto.randomUUID`
and `crypto.subtle`, which `core/guide/address`, `service`, `ondemand/files` and
`playlist/import` take from `node:crypto`.

## Runtime proof

`src/proof/` runs shared rules on Hermes, and `scripts/proof-server.ts` runs the same cases in
Node and compares them. Each area in `src/proof/groups/` loads on its own, so a module that fails
on Hermes fails only its group. Receipts go to `.local/ios-proof/` at the repository's root.

On the workbench, with the Mac mini's simulator (see the `mac-mini` skill):

```sh
node scripts/proof-server.ts 8790
REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_PROOF_URL=http://127.0.0.1:8790 \
  ./node_modules/.bin/expo start --port 8197
ssh -N -R 8081:127.0.0.1:8197 -R 8790:127.0.0.1:8790 mac-mini
onmac run -- zsh -c 'cd apps/ios && pnpm install --frozen-lockfile && npx expo run:ios --device <udid> --no-bundler'
```

Each launch of the app sends one report. The development build's only screen lists the cases; the
app's real screens wait for a picked design.
