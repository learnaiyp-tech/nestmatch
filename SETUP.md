# NestMatch — Complete Setup Guide

## Your live URL will be
```
https://YOUR_GITHUB_USERNAME.github.io/nestmatch
```

---

## PART 1 — GitHub Pages Deployment

### Step 1 · Create the GitHub repository

1. Go to https://github.com/new
2. Repository name: **nestmatch** (must match the `homepage` in package.json)
3. Visibility: Public (required for free GitHub Pages)
4. Click **Create repository**

### Step 2 · Update package.json homepage

Open `package.json` and replace `YOUR_GITHUB_USERNAME` with your actual GitHub username:

```json
"homepage": "https://YOUR_GITHUB_USERNAME.github.io/nestmatch"
```

### Step 3 · Add your secrets to GitHub

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these two secrets:

| Secret name                  | Value                                  |
|------------------------------|----------------------------------------|
| `REACT_APP_MAPS_KEY`         | Your Google Maps API key               |
| `REACT_APP_GDRIVE_CLIENT_ID` | Your Google OAuth Client ID            |

### Step 4 · Push the code

```bash
cd nestmatch
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/nestmatch.git
git push -u origin main
```

### Step 5 · Enable GitHub Pages

Go to your repo → **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: **gh-pages** / root
- Click **Save**

The GitHub Actions workflow will build and deploy automatically on every push.
Your site will be live at `https://YOUR_GITHUB_USERNAME.github.io/nestmatch` within ~2 minutes.

---

## PART 2 — Google Maps API Key

1. Go to https://console.cloud.google.com/
2. Create or select a project
3. **APIs & Services → Enable APIs** → enable:
   - **Maps JavaScript API**
   - **Places API**
4. **APIs & Services → Credentials → Create Credentials → API Key**
5. Click **Restrict Key**:
   - Application restrictions: **HTTP referrers**
   - Add these referrers:
     ```
     http://localhost:3000/*
     https://YOUR_GITHUB_USERNAME.github.io/*
     ```
   - API restrictions: Restrict to **Maps JavaScript API** + **Places API**
6. Copy the key → add it as `REACT_APP_MAPS_KEY` in GitHub Secrets

---

## PART 3 — Google Drive OAuth2 Setup

### Step 1 · OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User type: **External**
3. Fill in app name: `NestMatch`, your email
4. Scopes: add `.../auth/drive.file`
5. Test users: add your own Google email (while in testing mode)
6. Save

### Step 2 · Create OAuth Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Web application**
3. Name: `NestMatch Web`
4. Authorised JavaScript origins:
   ```
   http://localhost:3000
   https://YOUR_GITHUB_USERNAME.github.io
   ```
5. Authorised redirect URIs:
   ```
   http://localhost:3000
   https://YOUR_GITHUB_USERNAME.github.io/nestmatch
   ```
6. Click **Create** → copy the **Client ID**
7. Add it as `REACT_APP_GDRIVE_CLIENT_ID` in GitHub Secrets

### Step 3 · How the Drive flow works in the app

| Action | What happens |
|--------|-------------|
| Click **☁ Connect Drive** | Redirects to Google sign-in (PKCE OAuth2) |
| After sign-in | Returns to the app, token stored in sessionStorage |
| Tenant/Owner submits form | Excel auto-synced to **My Drive / NestMatch / nestmatch_data.xlsx** |
| Click **☁ Sync Drive** | Manually pushes latest data to Drive |
| Click **⬇ Export Excel** | Downloads file locally to your device |

The file is **replaced (not duplicated)** on every sync — Drive always has the latest version.

---

## PART 4 — Local development

```bash
# 1. Copy env template
cp .env.example .env

# 2. Fill in your keys in .env

# 3. Install and run
npm install
npm start
# → http://localhost:3000
```

---

## PART 5 — Re-deploy after changes

Just push to main — the GitHub Actions workflow does the rest:

```bash
git add .
git commit -m "Your change description"
git push
```

Check progress at: `https://github.com/YOUR_GITHUB_USERNAME/nestmatch/actions`
