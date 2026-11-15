# Gesserit

Two things live in this repository and are published from it:

| Part | Files | Where it runs |
|---|---|---|
| **Landing page** | `index.html`, `styles.css`, `assets/` | GitHub Pages, at [www.gesserit.org](https://www.gesserit.org). Published by `git push`. |
| **Members' forum** | `server/` | A Node server of your own, at `forum.gesserit.org`. Updated by `git pull` on that machine. |

They share `assets/`: the typeface, the colour palette and the emblem. The forum serves those files straight out of that folder, so **the forum needs the whole repository beside it, not only `server/`**.

## Run it on your own machine

You need [Node](https://nodejs.org) 24 or later (`brew install node`). There is nothing to build.

```sh
cd server
npm install     # once
npm start
```

The forum is then at <http://127.0.0.1:8787>. Stop it with Ctrl+C.

The first time, make yourself an admin. The password is printed once:

```sh
npm run add-user -- --admin zan "Zan Huang"
```

After that, members are added from the **Members** page, where an admin can also make someone a sub-admin and choose what they may do.

| Command (in `server/`) | What it does |
|---|---|
| `npm start` | Runs the forum. |
| `npm run dev` | Runs it and restarts whenever a file changes. |
| `npm test` | Runs the tests, against a scratch database. |
| `npm run add-user -- --admin <sign-in name> "<Full Name>"` | Adds an admin. Without `--admin`, a member. |
| `npm run add-user -- --reset <sign-in name>` | Gives someone a new password. |
| `npm run add-user -- --main <sign-in name>` | Names the main admin, whose writing is the canon. |

To look at the landing page, open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000     # then http://127.0.0.1:8000
```

### Where the forum keeps things

Everything members write, their password hashes and their pictures are in `server/data/`. Git ignores that folder; it never leaves the machine the forum runs on. The database brings itself up to date when the forum starts after an update.

### Settings

None are needed on your own machine. On a server they go in `server/.env`, which git also ignores; copy `server/.env.example` and take the `#` off what you want.

| Setting | Default | What it is |
|---|---|---|
| `PUBLIC_URL` | none | Where members reach the forum, e.g. `https://forum.gesserit.org`. Set it on the server; leave it out locally. |
| `TRUST_PROXY` | off | Set to `1` behind Caddy or nginx. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where it listens. |
| `DATA_DIR` | `server/data` | Where the database and pictures are kept. |
| `LANDING_URL` | `https://gesserit.org/` | Where "gesserit.org" at the foot of each page leads. |
| `LATEX`, `DVISVGM` | found on the PATH | The programs that draw diagrams. `off` leaves diagrams undrawn; without LaTeX installed that happens by itself. |

## Publish

### To git, which publishes the landing page

```sh
git add -A
git commit -m "What changed"
git push
```

GitHub Pages rebuilds www.gesserit.org within a minute or two. `_config.yml` keeps `server/` and `tools/` off that website, and `.gitignore` keeps the database, `.env` and `node_modules` out of git altogether.

If git asks who you are the first time:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.org"
```

### The forum, on a server: the first time

On a Linux machine with Node 24 or later, git and [Caddy](https://caddyserver.com), and with the DNS name `forum.gesserit.org` pointing at it:

```sh
sudo useradd --system --create-home --home-dir /srv/gesserit gesserit
sudo -u gesserit -H bash      # the lines down to `exit` are run as the forum's own user
cd ~
git clone https://github.com/TheMandateofMN/TheMandateofMN.github.io.git site
cd site/server
npm ci --omit=dev
cp .env.example .env
nano .env                     # take the # off PUBLIC_URL and TRUST_PROXY
npm run add-user -- --admin zan "Zan Huang"
exit
```

Then have it kept running, and put it on the web:

```sh
cd /srv/gesserit/site/server
sudo cp deploy/gesserit-forum.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gesserit-forum
```

Add what is in `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`. Caddy gets the certificate by itself.

To bring across what is already on your own machine instead of starting empty, stop both forums and copy your `server/data/` folder to `/srv/gesserit/site/server/data/` on the server, owned by `gesserit`.

### The forum, on a server: each update

After a `git push`, on the server:

```sh
cd /srv/gesserit/site
sudo -u gesserit -H git pull
sudo -u gesserit -H npm --prefix server ci --omit=dev
sudo systemctl restart gesserit-forum
```

`journalctl -u gesserit-forum -f` shows what it says while it runs.

### Backups

Everything worth keeping is the one folder. Stop the forum so the copy is whole:

```sh
sudo systemctl stop gesserit-forum
sudo cp -a /srv/gesserit/site/server/data /srv/gesserit/data-$(date +%F)
sudo systemctl start gesserit-forum
```

## How the two parts stay in step

- **Colours.** `assets/palette.css` is the one place they are named; `styles.css` and `server/public/forum.css` say what each is used for. The vines in the margins are SVGs and cannot read it, so after changing a colour copy it into the list at the head of `tools/build-ornament.mjs` and run `node tools/build-ornament.mjs`.
- **Links.** The landing page's "Sign in" goes to `https://forum.gesserit.org/` (in `index.html`); the forum leads back through `LANDING_URL`. Have the forum answering before you push a landing page that points at it.
- **Fresh files.** `index.html` and `styles.css` load their files with a stamp, like `styles.css?v=29`. Raise the number when you change the file, so browsers fetch it again. The forum stamps its own.
- **Checked for you.** `npm test` includes `server/test/site.test.mjs`, which fails if either page reads a colour the palette lacks, if the vines are out of date, if a shared file has gone missing, or if the database is no longer kept out of git.
