# Horse Cargo — Cargo Operating System (v1.0)

Web app (HTML · CSS · JavaScript) + Android APK (Capacitor) + Supabase backend.
Imejengwa kwa kutumia features za **ACMS** kama reference, na kanuni za **Horse Cargo Operating Blueprint**.

> 🇬🇧 English summary at the bottom.

---

## 1. Kilichomo

```
horse-cargo-app/
├── www/                     ← App yenyewe (HTML/CSS/JS) — web na APK zinatumia hii hii
│   ├── index.html           ← App ya wafanyakazi (login)
│   ├── track.html           ← Ukurasa wa umma wa kufuatilia mzigo (hauhitaji login)
│   ├── config.js            ← ⚠️ Weka Supabase URL + anon key hapa
│   ├── css/app.css
│   ├── js/                  ← app.js (router), api.js, ui.js, i18n.js (EN/SW), scanner.js
│   │   └── pages/           ← dashboard, bookings, booking, grn, customers, shipments, reports …
│   ├── vendor/              ← supabase-js, qrcode, html5-qrcode (offline, hakuna CDN)
│   ├── manifest.webmanifest + sw.js   ← PWA (inaweza ku-install kwenye simu/PC)
│   ├── img/                 ← logo.jpg (asili), logo-white.png, mark-white.png (farasi tu)
│   └── icons/               ← icons za PWA zilizotokana na logo
├── supabase/
│   ├── schema.sql           ← Tables, views, RLS, business rules (RPC)
│   ├── seed.sql             ← Matawi DXB/DAR/MWZ, settings, aina za mizigo + viwango (placeholder)
│   └── storage.sql          ← (hiari) bucket ya picha za GRN
├── android/                 ← Capacitor Android project (tayari imetengenezwa)
├── .github/workflows/build-apk.yml   ← GitHub inajenga APK yenyewe
├── capacitor.config.json · package.json · netlify.toml
└── test/                    ← Local test server + Playwright E2E (si lazima kwa production)
```

## 2. Modules

| Module | Inafanya nini |
|---|---|
| **Dashboard** | CBM ghalani, madeni, makusanyo leo/mwezi, pipeline ya status 8, makontena, matukio ya karibuni |
| **Wateja** | Namba `HC-C-00001`, TIN, kitambulisho, kikomo cha mkopo, salio, historia ya booking, WhatsApp |
| **Booking** | Mteja → njia (bahari/anga, DXB/DAR/MWZ) → aina ya mzigo → makadirio ya bei + amana inayohitajika. Onyo la vibali (TBS/TMDA) na kuzuia mizigo ya TASAC (GN 184/2025) |
| **GRN (ghala)** | Vipimo kwa mistari (vipande × L×W×H, kg) → CBM, kg za ujazo, kg za kulipia → **bei inafungwa hapa** na ankara inaundwa yenyewe |
| **Ankara** | Nauli (imefungwa) + gharama za ziada + ushuru (kama deni, si mapato) + punguzo (meneja tu) |
| **Malipo** | USD / AED / TZS na exchange rate, cash/benki/pesa ya simu/kadi, risiti `HC-RCT-…`, kubatilisha (meneja, na sababu) |
| **Makontena** | `HC-SEA-DXB-DAR-0001`, namba ya kontena/seal/BL, uwezo wa CBM & % ya matumizi, kupakia kwa kuchagua au **kwa kuskani QR**, Imeondoka → Imefika (booking zote zinabadilika pamoja) |
| **Forodhani → Tayari → Kukabidhi** | Makabidhiano yanahitaji jina/simu/kitambulisho, hati ya makabidhiano |
| **Skani** | Kamera inasoma QR ya lebo ya katoni → inafungua booking |
| **Nyaraka** | Ankara, risiti, GRN, lebo za katoni (HORSE CARGO / ref / destination / PIECE n OF N + QR), waybill, orodha ya upakiaji, hati ya makabidhiano — zote EN/SW |
| **Ripoti** | Makusanyo (kwa njia/sarafu/tawi), madeni kwa umri (0–30/31–90/90+), mapato vs ushuru, ujazo kwa njia — CSV |
| **Viwango (Rate card)** | USD/CBM bahari, USD/kg anga, kima cha chini |
| **Watumiaji, Audit log, Settings** | Roles 8, kila hatua muhimu inaandikwa kwenye audit log |
| **Ufuatiliaji wa umma** | `track.html?ref=HC-BK-2609-0001` — hauonyeshi fedha wala mawasiliano ya mteja |

## 3. Kanuni zinazolazimishwa na database (haziwezi kukwepwa kutoka app wala API)

1. **Kizuizi cha amana** — mzigo hauwezi kupokelewa ghalani (GRN) kabla amana haijalipwa.
2. **Kizuizi cha malipo** — mzigo haukabidhiwi kukiwa na deni (admin tu anaweza kuruhusu kwa sababu iliyoandikwa kwenye audit).
3. **Bei inafungwa kwenye GRN**, si kwenye makadirio.
4. **Mgawanyo wa majukumu** — aliyepima mzigo ≠ aliyepokea fedha ≠ aliyekabidhi mzigo.
5. Status, namba za kumbukumbu, vipimo na fedha **haviwezi kuhaririwa moja kwa moja** — vinabadilika kupitia functions za database tu. Hakuna mtu anayeweza kufuta (DELETE) rekodi.

| Cheo | Anaweza |
|---|---|
| Administrator | Kila kitu + watumiaji |
| Manager | Kila kitu isipokuwa kusimamia watumiaji; punguzo, kubatilisha, kughairi |
| Counter / Sales | Wateja, booking, gharama za ziada |
| Cashier | Malipo, wateja |
| Warehouse | GRN, kupakia kontena |
| Operations | Makontena, forodhani/tayari, gharama |
| Release officer | Kukabidhi mzigo |
| Viewer | Kuangalia tu |

Namba: `HC-C-#####` · `HC-BK-YYMM-####` · `HC-GRN-DXB-YYMM-####` · `HC-INV-YYMM-####` · `HC-RCT-YYMM-####` · `HC-SEA-DXB-DAR-####` · `HC-REL-YYMM-####`

---

## 4. Kuweka mfumo hewani (hatua kwa hatua)

### A. Supabase (dakika ~10)
1. Fungua project mpya kwenye [supabase.com](https://supabase.com) (region: *Frankfurt* au karibu na UAE/TZ).
2. **SQL Editor** → bandika `supabase/schema.sql` yote → **Run**.
3. Kisha `supabase/seed.sql` → **Run**. (Hiari: `supabase/storage.sql` kwa picha za GRN.)
4. **Authentication → Providers → Email**: iwe ON. Kama hutaki barua ya kuthibitisha email, zima *Confirm email*.
5. **Project Settings → API**: nakili *Project URL* na *anon public key*.

### B. Config
Fungua `www/config.js` weka:
```js
SUPABASE_URL: 'https://xxxx.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi...',
PUBLIC_TRACK_URL: 'https://app.horsecargoltd.com/track.html',
```
(anon key ni salama kuwa kwenye app — kila table inalindwa na Row Level Security.)

### C. Web app (Netlify / Vercel / Hostinger)
- **Netlify**: unganisha GitHub repo — `netlify.toml` tayari inasema publish folder ni `www`. Au buruta folder `www` kwenye Netlify Drop.
- **Hostinger**: pakia yaliyomo ndani ya `www/` kwenye `public_html` (au subdomain `app.horsecargoltd.com`).
- Link ya tracking kwa website ya horsecargoltd.com: `https://app.horsecargoltd.com/track.html`

### D. ⚠️ Mtumiaji wa kwanza = Admin
Mara tu baada ya kupeleka hewani: fungua app → **"Mfanyakazi mpya? Omba kuingia"** → jisajili.
**Mtu wa kwanza kujisajili anakuwa Administrator moja kwa moja.** Wafanyakazi wengine wanajisajili hivyo hivyo, kisha admin anawapa cheo + tawi kwenye **Watumiaji** na kuwawasha.

### E. APK ya Android
1. Pakia project hii kwenye GitHub repo (branch `main`).
2. GitHub → **Actions** → *Build Android APK* inajiendesha (au bofya **Run workflow**).
3. Ikimaliza (~6–8 dk) → fungua run → **Artifacts** → pakua `horse-cargo-apk-N` → ndani kuna `horse-cargo-debug-N.apk` → install kwenye simu (ruhusu "Install unknown apps").

Kila ukipush mabadiliko ndani ya `www/`, APK mpya inajengwa yenyewe.

**Kwa Google Play (release iliyosainiwa)** — tengeneza keystore mara moja tu, ihifadhi salama:
```bash
keytool -genkey -v -keystore horse-cargo.jks -keyalg RSA -keysize 2048 -validity 10000 -alias horsecargo
base64 -w0 horse-cargo.jks   # nakili matokeo
```
GitHub → Settings → Secrets → Actions: `HC_KEYSTORE_BASE64`, `HC_KEYSTORE_PASSWORD`, `HC_KEY_ALIAS` (=horsecargo), `HC_KEY_PASSWORD`.
(Hiari: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PUBLIC_TRACK_URL` — workflow itaandika `config.js` yenyewe.)

Kujenga kwenye PC yako (ukiwa na Android Studio / SDK): `npm install && npm run apk:debug`

---

## 5. Kabla ya kuanza kutumia (maamuzi ya client — Blueprint §20)

- [ ] **Viwango halisi** kwenye *Rate card* — vilivyomo ni placeholder (mf. $180/CBM bahari).
- [ ] **Asilimia ya amana** (sasa: bahari 30%, anga 50%) — *Settings*.
- [ ] **Exchange rates** AED/TZS — *Settings* (zinaweza kubadilishwa kila malipo pia).
- [ ] Siku za kuhifadhi bure na gharama kwa siku (sasa zinaongezwa kama "gharama ya ziada" manually).
- [ ] Nani ni release officer Dar na Mwanza.
- [x] Logo na rangi za Horse Cargo zimewekwa (burgundy `#800C1F` + nyeupe). Ukipata logo ya ubora wa juu (SVG/PNG ≥1024px), badilisha `www/img/*`, `www/icons/*` na `android/app/src/main/res/mipmap-*` ili icon ya APK iwe kali zaidi.

## 6. Mipaka ya v1 (kwa v2)

- **Kuprint** kunafanya kazi kwenye web (browser). Kwenye APK, tumia *Tuma WhatsApp* au fungua web kuprint.
- **CSV** kwenye APK inatumia share sheet ya simu; kwenye web inapakuliwa.
- Hakuna bado: portal ya mteja, SMS/WhatsApp za kiotomatiki, malipo mtandaoni (Selcom), gharama za storage za kiotomatiki, ledger kamili ya uhasibu / P&L kwa kila kontena, HR. Muundo wa database uko tayari kuongeza hivi.

## 7. Majaribio yaliyofanyika

Yamejaribiwa kwenye Postgres 16 halisi na schema hii hii + RLS, kupitia supabase-js na Chromium (Playwright):
booking → amana (AED + USD) → kizuizi cha amana → GRN (bei imefungwa: 2.602 CBM × $250 = $650.50) → ushuru + delivery → kontena → pakia → imeondoka → imefika → tayari → **kizuizi cha malipo kimezuia** → malipo TZS (M-Pesa) → makabidhiano → nyaraka → tracking ya umma. Pia: mgawanyo wa majukumu, roles, kuhariri status moja kwa moja (kumekataliwa), insert ya risiti moja kwa moja (imekataliwa na RLS), mobile 400px + Kiswahili. Hakuna JS errors.

Kujaribu local: `test/README-test.md`.

---

## 🇬🇧 English summary

Horse Cargo OS is a vanilla HTML/CSS/JS progressive web app backed by Supabase (Postgres + Auth + RLS), packaged for Android with Capacitor. All business rules live in the database as `SECURITY DEFINER` RPCs guarded by role checks and trigger guards, so the web app, the APK and any direct API call are held to the same rules: deposit gate before warehouse receipt, settlement gate before release, price lock at GRN, duty as a receivable, three-way segregation of duties, append-only money records with voiding and a full audit log.

**Setup:** run `supabase/schema.sql` then `seed.sql` in the Supabase SQL editor → put the project URL and anon key in `www/config.js` → deploy `www/` to Netlify/Vercel/Hostinger → the first person to sign up becomes admin → push to GitHub and download the APK from the *Build Android APK* workflow artifacts. Set real rates, deposit percentages and FX in the app before go-live.
