# How to run it locally (quick start)

## 1. Create a GitHub OAuth App
- github.com → your avatar → **Settings** → **Developer settings** (bottom of left sidebar)
- **OAuth Apps** → **New OAuth App**
- **Homepage URL:** `http://localhost:8788`
- **Authorization callback URL:** `http://localhost:8788/api/auth/callback`
- Register → copy the **Client ID**, then **Generate a new client secret** and copy it.

## 2. Fill in your secrets
Open the file **`.dev.vars`** in this folder and paste your Client ID and Client Secret
where indicated. Save.

## 3. Run it
Open a terminal **in this folder** (the one containing `public/` and `functions/`) and run:

```bash
npx wrangler pages dev public
```

The first time, it may ask to install Wrangler — say yes. When it's ready it prints
a line like:

```
[wrangler] Ready on http://localhost:8788
```

Open **http://localhost:8788** in your browser. You'll see the editor with a
**"በGitHub ይግቡ · Sign in"** button. Click it to log in with GitHub.

## 4. Stop it
Press **Ctrl + C** in the terminal.

---

## Notes
- **Node.js** must be installed (v20+). Check with `node --version`. Get it at nodejs.org.
- **Everyone who edits must be a COLLABORATOR** on the private repo
  `hizclick/welde-mariam-digital-edition`. Add them on GitHub:
  repo → **Settings → Collaborators → Add people**. (No forks are used — each
  person edits on their own branch `edit-<their-username>` in the same repo.)
- The first time a user clicks **Load**, the app auto-creates their branch from
  `main`. After that, their branch is their workspace; it's refreshed from main
  when their PRs merge.
- If sign-in says "auth error": double-check the callback URL in your OAuth App is
  exactly `http://localhost:8788/api/auth/callback` and that `.dev.vars` has the
  right Client ID/Secret.
- If port 8788 is busy, Wrangler may pick another port — use whatever URL it prints,
  and update the OAuth App's Homepage + callback URLs to match that port.
