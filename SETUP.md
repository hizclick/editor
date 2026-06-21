# Stage 3 — GitHub login & the full review workflow

This adds **GitHub sign-in**, **save-to-your-fork**, **automatic pull requests**,
a **review inbox** (many reviews per reviewer), **approve-and-merge**, and
**notifications to @hizclick** — all on top of the Stage 1/2 editor.

It is **not** a single HTML file anymore. GitHub OAuth needs a *client secret*
that must never live in browser code, so this stage has three parts:

1. **A GitHub App / OAuth App** — registered once on GitHub (grants fork/commit/PR rights).
2. **Cloudflare Pages Functions** — small serverless endpoints under `functions/api/*`
   that hold the secret and talk to GitHub.
3. **The editor UI + `stage3.js`** — the sign-in button, save-to-fork, and review inbox.

Everything users see is in Amharic. Users never see "fork", "commit", or "PR".

---

## File layout

```
stage3/
  functions/
    api/
      _gh.js                  shared GitHub helpers
      auth/
        login.js              GET  /api/auth/login     → redirect to GitHub
        callback.js           GET  /api/auth/callback   → exchange code, set cookie
        me.js                 GET  /api/auth/me · POST /api/auth/logout
      repo/
        load.js               GET  /api/repo/load       → read TEI from the user's fork
        save.js               POST /api/repo/save       → commit to fork + open PR + assign reviewer + notify
      review/
        inbox.js              GET  /api/review/inbox     → list PRs awaiting this reviewer (many)
        files.js              GET  /api/review/files      → base+head TEI for a PR (for the diff)
        comment.js            POST /api/review/comment    → comment to author (+ notify admin)
        approve.js            POST /api/review/approve    → approve + merge (conflict → notify admin)
  public/
    stage3.js                 front-end client (include after the editor script)
    index.html                your editor (tei-editor.html) — see step 4
  .env.example                the environment variables you must set
```

---

## Step 1 — Register a GitHub OAuth App

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name:** `Welde-Mariam Family Editor`
   - **Homepage URL:** `https://your-edition.pages.dev`
   - **Authorization callback URL:** `https://your-edition.pages.dev/api/auth/callback`
3. Create it. Copy the **Client ID**, and generate a **Client Secret**.
   (A GitHub *App* works too and is more scoped, but an OAuth App is the simplest
   way to act *as the signed-in user* so "commit to their own fork" is literally true.)

> The OAuth scope requested is `repo read:user` so the app can read/write repo
> contents and open PRs on the user's behalf.

---

## Step 2 — Create the upstream repo and have contributors fork it

1. Put the edition (the TEI file + `photos/` + the built `index.html`) in a GitHub
   repo owned by **@hizclick** (or your org). This is the **upstream**.
2. Each family member, once, clicks **Fork** on that repo (or the app's onboarding
   walks them through it). Per our decision, the app **assumes the fork already exists**.

---

## Step 3 — Deploy to Cloudflare Pages

1. Push this `stage3/` folder to a GitHub repo (or upload directly).
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Build settings: **Framework preset = None**, **Build output directory = `public`**.
   (The `functions/` folder is picked up automatically as Pages Functions.)
4. **Settings → Environment variables** → add everything from `.env.example`
   (use your real values). Mark `GITHUB_CLIENT_SECRET` as encrypted.
5. Deploy. Your app is at `https://your-edition.pages.dev`.

---

## Step 4 — Wire `stage3.js` into the editor

Copy `tei-editor.html` into `public/index.html`, and just before `</body>` add:

```html
<script src="stage3.js"></script>
```

That's it. `stage3.js` injects the **Sign in with GitHub** button into the top bar,
and once signed in it adds **Load from GitHub** and **Submit for review**, and fills
the **Review** tab with the signed-in reviewer's inbox.

---

## The full flow (what happens)

**Author**
1. Clicks **በGitHub ይግቡ** → GitHub login → back to the app (token kept in an
   HttpOnly cookie; browser JS never sees it).
2. **ከGitHub ጫን · Load** → reads the TEI from *their fork*.
3. Edits / annotates / adds photos as in Stage 1.
4. **ላክ ለግምገማ · Submit for review** → the server commits to a new branch on
   their fork, commits any photos into `photos/`, opens a **PR to upstream**,
   assigns **@hizclick** as reviewer, and posts a comment that notifies the admin.

**Reviewer (@hizclick, or any reviewer)**
1. Opens the app → **Review** tab shows **all** PRs awaiting them (a real queue —
   many reviews per reviewer).
2. **ለውጦችን አሳይ · show changes** → runs the same Stage-2 plain-Amharic diff.
3. **አስተያየት ላክ · comment** → posts a comment that @-mentions the author (their
   in-app/GitHub notification) and ccs the admin.
4. **✓ አጽድቅ · approve** → approves and merges. If there's a **merge conflict**,
   it is **not** dumped on the reviewer — the app posts a comment notifying
   **@hizclick** to resolve it manually, and tells the reviewer it was escalated.

**Admin (@hizclick)** is @-mentioned on: every new PR, every comment, and every
conflict — so they can see who is engaging and phone contributors who aren't
active in the app.

---

## Security notes

- The GitHub **access token lives only in an HttpOnly cookie**. Browser JavaScript
  cannot read it. Every GitHub call goes through the Cloudflare Functions, which
  read the cookie server-side.
- The **client secret** lives only in Cloudflare environment variables, never in
  the browser or the repo.
- OAuth **state** is verified via a short-lived HttpOnly cookie (CSRF protection).
- For higher security you can swap the token-in-cookie for a server-side session
  store (Cloudflare KV) keyed by a random session id; the code is structured so
  this is a localized change in `auth/callback.js` + `_gh.js`.

---

## Customizing

- **Add a reviewer:** set `REVIEWERS=hizclick,anotherlogin` (comma-separated).
- **Change who gets notified:** set `ADMIN_LOGIN`.
- **Different file path / branch:** `TEI_PATH`, `UPSTREAM_BRANCH`.
