# Tavo — iPad & Android Apps (Capacitor)

Tavo's tablet apps wrap the same web POS in a native shell using **Capacitor**, so the
iPad/iOS and Android apps share one codebase and talk to your hosted backend
(`https://platepoint.onrender.com` by default — change `BACKEND_URL` in `public/index.html`
if you rename your service).

You build these on your own machine. iOS requires a **Mac with Xcode**; Android requires
**Android Studio**. You also need developer accounts to publish: Apple Developer ($99/yr)
and Google Play ($25 one-time).

---

## One-time setup

```bash
cd platepoint
npm install                      # installs Capacitor (in devDependencies)
npx cap init Tavo com.tavo.pos   # already configured in capacitor.config.json; safe to skip
npm run mobile:build             # copies the web app into www/
npx cap add ios                  # creates the ios/ Xcode project   (Mac only)
npx cap add android              # creates the android/ Studio project
```

## Generate app icons & splash (uses resources/icon.svg)

```bash
# rasterize the icon if you don't already have resources/icon.png (1024x1024)
npx @capacitor/assets generate --iconBackgroundColor '#ff5722' --splashBackgroundColor '#0f1115'
```

This produces all the required icon/splash sizes for both platforms from `resources/icon.png`.

## Run on a device or simulator

```bash
npm run mobile:ios       # builds www, syncs, opens Xcode → press ▶ to run on an iPad/simulator
npm run mobile:android   # builds www, syncs, opens Android Studio → press ▶
```

Every time you change the web app, re-run `npm run mobile:sync` (or the `mobile:ios` /
`mobile:android` scripts, which sync first).

---

## Publishing

### iOS App Store
1. In Xcode: set your **Team** (Signing & Capabilities) and a unique **Bundle Identifier** (`com.tavo.pos`).
2. Product → **Archive**, then **Distribute App → App Store Connect**.
3. In [App Store Connect](https://appstoreconnect.apple.com), create the app, fill in screenshots/description, and submit for review.

### Google Play
1. In Android Studio: **Build → Generate Signed Bundle/APK → Android App Bundle**, create a keystore (keep it safe).
2. In the [Play Console](https://play.google.com/console), create the app, upload the `.aab`, complete the listing, and roll out.

### App-review tips (so you don't get rejected)
- Tavo is a real business tool with native value (offline mode, printing, device login), not just a website wrapper — that satisfies Apple's minimum-functionality guideline.
- **Payments:** card processing for restaurant food (physical goods/services) is allowed via Stripe; Apple/Google's in-app-purchase rules only apply to *digital* goods, so you're fine.
- Provide a **demo login** (Manager PIN) in the review notes so reviewers can get in.

---

## How it connects

- The native app loads the bundled web UI from `www/`.
- Because it runs as a native app, `IS_NATIVE` is true and the app calls your hosted API at
  `BACKEND_URL`. On the web it stays same-origin. (See the top of `public/index.html`.)
- Offline mode, printing, receipts, and everything else work exactly as on the web.

## Optional native polish

Add Capacitor plugins for a more native feel (then `npm run mobile:sync`):

```bash
npm i @capacitor/status-bar @capacitor/splash-screen @capacitor/network
```
