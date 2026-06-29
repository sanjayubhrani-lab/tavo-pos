# Tavo — iOS & Android apps (Capacitor)

Tavo ships as native **iOS (iPad/iPhone)** and **Android** apps that wrap the same web POS
in a native shell using **Capacitor**. The UI is **bundled into the app** (so it launches
instantly and works offline), while data calls go to your hosted backend at
`https://app.tavopoint.com` — already wired via `BACKEND_URL` + `IS_NATIVE` in
`public/index.html`. One codebase, both stores.

You compile the binaries **on your own Mac** (iOS needs Xcode; Android needs Android Studio).
To publish you need an **Apple Developer** account ($99/yr) and a **Google Play Developer**
account ($25 one-time). The web/backend is already live and is *not* part of these builds.

The repo is pre-configured: `capacitor.config.json` (appId `com.tavo.pos`, appName **Tavo**),
the mobile build scripts in `package.json`, and branded icon/splash sources in `resources/`
are all in place.

---

## 0. Prerequisites (one time, on a Mac)

- **Node 18+**, Xcode (App Store) + Command Line Tools (`xcode-select --install`) +
  CocoaPods (`sudo gem install cocoapods`).
- **Android Studio** (bundles the Android SDK + an emulator).
- Optional: a physical iPad / Android tablet for real-device testing.

---

## 1. Generate the native projects

```bash
cd platepoint
npm install                 # server deps
npm run mobile:install      # adds Capacitor deps (kept out of the server deploy to keep builds lean)
npm run mobile:add          # copies the web app to www/ then runs `cap add ios` + `cap add android`
```

Creates `ios/` (Xcode project) and `android/` (Android Studio project). The config is
already set, so `npx cap init` is **not** needed.

## 2. Brand the icon & splash

`resources/` already contains the Tavo `icon.png` (1024×1024), adaptive
`icon-foreground/background.png`, and `splash.png` (2732×2732). Generate every platform size:

```bash
npm run mobile:assets       # @capacitor/assets → all icon/splash sizes
npx cap sync                # copies them into ios/ and android/
```

## 3. Sync, run, build

After any web-app change, refresh the bundle and sync:

```bash
npm run mobile:sync         # rebuilds www/ from public/ and runs `cap sync`
```

**iOS**
```bash
npm run mobile:ios          # opens Xcode
```
Pick a Simulator/device → ▶ to run. For the store: set your Team under *Signing &
Capabilities*, bump version/build, then *Product → Archive*.

**Android**
```bash
npm run mobile:android      # opens Android Studio
```
Pick an emulator/device → ▶ to run. For Play: *Build → Generate Signed Bundle/APK →
Android App Bundle (.aab)*.

> Quick sideload APK (no Studio): `cd android && ./gradlew assembleDebug`
> → `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## 4. Submit to the App Store (iOS)

1. In **App Store Connect**, create the app (bundle ID `com.tavo.pos`).
2. Xcode *Product → Archive → Distribute App → App Store Connect → Upload*.
3. Listing: name **Tavo**, subtitle, description, keywords, support + privacy-policy URLs,
   screenshots (iPad 12.9″ + iPhone 6.7″).
4. Complete the **App Privacy** questionnaire (you collect business/order data; no ad tracking).
5. Submit for review — describe the merchant/POS workflow; mention any card reader/terminal.

## 5. Submit to Google Play (Android)

1. In the **Play Console**, create the app (package `com.tavo.pos`).
2. Upload the signed **.aab** (Internal testing → Closed → Production).
3. Complete the listing (title, short/full description, feature graphic 1024×500, phone +
   tablet screenshots), **Data safety** form, and content rating.
4. Roll out to Internal testing first, then promote to Production.

---

## Distribution without the stores (fastest for your own fleet)

- **Android:** sideload the debug/signed APK directly or push via MDM — instant.
- **iOS:** Ad Hoc / Enterprise distribution or TestFlight for your own iPads.
- **No app at all:** open `https://app.tavopoint.com` full-screen as a **PWA/kiosk** on the
  tablet browser — zero review, always current. The native app mainly adds offline launch,
  kiosk lock-down, and native hardware access.

---

## What the native shell adds over the website

- **Instant, offline launch** — UI bundled; orders/payments already queue offline and sync back.
- **Home-screen icon + splash**, full-screen, and app-store presence.
- A hook point for **native hardware** (receipt printer, cash drawer, card reader / Valor SDK)
  via Capacitor plugins.

## Configuration reference

- Backend URL: `BACKEND_URL` in `public/index.html` (currently `https://app.tavopoint.com`);
  re-run `npm run mobile:sync` after changing it.
- App identity: `capacitor.config.json` → `appId` / `appName`.
- In-app webview allow-list: `server.allowNavigation` in `capacitor.config.json`.
