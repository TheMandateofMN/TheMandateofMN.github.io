# Gesserit

Two things live in this repository and are published from it:

| Part | Files | Where it runs |
|---|---|---|
| **Landing page** | `index.html`, `styles.css`, `assets/` | GitHub Pages, at [www.gesserit.org](https://www.gesserit.org). Published by `git push`. |
| **Members' forum** | `server/` | A Node server at `forum.gesserit.org`: on [Fly.io](https://fly.io), published by `fly deploy`, or on a machine of your own. |

They share `assets/`: the typeface and the colour palette. The forum serves those files straight out of that folder, so **the forum needs the whole repository beside it, not only `server/`**.

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

After that, members are added with the same command without `--admin`, or from the [admin portal](#the-admin-portal), which does that and more from one place. The forum itself adds nobody for now: its **Members** page (linked from **Scribe**, the first page of anyone who keeps the corpus) is where an admin makes someone a sub-admin and chooses what they may do, gives a new password, and removes or restores someone; and [Invitations](#invitations) is put away.

| Command (in `server/`) | What it does |
|---|---|
| `npm start` | Runs the forum. |
| `npm run dev` | Runs it and restarts whenever a file changes. |
| `npm test` | Runs the tests, against a scratch database. |
| `npm run add-user -- --admin <sign-in name> "<Full Name>"` | Adds an admin. Without `--admin`, a member. |
| `npm run add-user -- --reset <sign-in name>` | Gives someone a new password. |
| `npm run add-user -- --rename <sign-in name> "<New Name>"` | Changes the name someone is shown by. They sign in as before. |
| `npm run add-user -- --main <sign-in name>` | Names the main admin, whose writing is the canon. |

To look at the landing page, open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000     # then http://127.0.0.1:8000
```

### Where the forum keeps things

Everything members write, their password hashes and their pictures are in `server/data/`. Git ignores that folder; it never leaves the machine the forum runs on. The database brings itself up to date when the forum starts after an update.

Three folders beside the database belong to [Send](#send-one-box-for-both-chats): `signal/` and `whatsapp/` hold the keys that make the forum a device of the main admin's accounts there, and `outbox/` holds files on their way to the chats, deleted once they have gone. Treat the two key folders as you would the telephone they were linked from.

### Settings

None are needed on your own machine. On Fly.io they are already set, in `fly.toml`. On a server of your own they go in `server/.env`, which git also ignores; copy `server/.env.example` and take the `#` off what you want.

| Setting | Default | What it is |
|---|---|---|
| `PUBLIC_URL` | none | Where members reach the forum, e.g. `https://forum.gesserit.org`. Set it on the server; leave it out locally. |
| `TRUST_PROXY` | off | How the forum learns a visitor's address behind a proxy, for the limit on wrong passwords. `1` behind Caddy or nginx; `Fly-Client-IP` on Fly.io. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where it listens. |
| `DATA_DIR` | `server/data` | Where the database and pictures are kept. |
| `LANDING_URL` | `https://gesserit.org/` | Where "gesserit.org" at the foot of each page leads. |
| `LATEX`, `DVISVGM` | found on the PATH | The programs that draw diagrams. `off` leaves diagrams undrawn; without LaTeX installed that happens by itself. |
| `PUSH_CONTACT` | `LANDING_URL` | An address (`mailto:` or `https:`) that a notification service can write to about what the forum sends through it. |
| `PUSH_HOSTS` | none | Further notification services to send through, as host names separated by commas. Apple's, Google's, Mozilla's and Microsoft's are already allowed, and nothing is sent anywhere else. |
| `PUSH_DELAY_MS` | `5000` | How long the forum waits before notifying of a message, so that whoever is reading the conversation is not told of it. |
| `NUMBERS_KEY` | none | The secret that telephone numbers are sealed with in the database: any 32 characters or more. Without it no number can be kept. See [Invitations](#invitations). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | none | The [Twilio](https://www.twilio.com) account that texts are sent through. Without them numbers can be kept and nothing can be sent. |
| `TWILIO_FROM` | none | What texts are sent from: a number of that account's, as `+14155550100`, or one of its messaging services, as `MG…`. |
| `TEXT_GAP_MS` | `1100` | How long the forum leaves between one text and the next when it sends many, in thousandths of a second. |
| `SIGNAL_CLI` | found on the PATH | The `signal-cli` program, if it is somewhere unusual. See [Send](#send-one-box-for-both-chats). |
| `PACE` | on | `off` stops the forum refusing a member who asks for pages faster than anyone reads. |
| `MESSAGES` | off | `on` brings back the conversations between members. They are put away, not removed: what was said is kept. |
| `PROJECTS` | off | `on` brings back the projects, put away in the same way. |
| `NOTIFICATIONS` | off | `on` brings back the notifications sent to members' devices. While it is off no device is taken on and none is told anything. |
| `VERSIONS` | off | `on` brings back the pages a piece's earlier wordings are read, compared and put back from. The wordings are kept either way. |
| `INVITATIONS` | off | `on` brings back [Invitations](#invitations), the admins' list of those to be invited. A link already handed out is taken up either way. |

### Who does what

- **Scribe** is the tab the corpus is kept from, and only those who keep it have it: admins, and sub-admins given *Scribe*, *Edit what is written* or *Manage members*. Its page, **Editorial**, lists every piece in two tables, the succession (what is written here) and the antecedents, each with its status and the way to edit it. No date is shown for any piece, anywhere.
- **A piece's status** is one of Not Started, In Progress, Drafted, Finished and Published, chosen in its row. Published is what members can read; choosing anything else takes a piece back. Nothing is sorted by it: those who edit drag the rows of each table into the order they want (or move a row with the arrow keys), and a new piece comes in at the head of its table.
- **Only those who keep the corpus add to it**: **New Piece**, on Editorial and on the Corpus, and **Antecedent**, on the Corpus, are theirs alone, and they publish what they add themselves. There is nothing to review, and a member sends nothing in. Everyone else comes to the **Corpus** first, and reads.
- **The corpus** is set out about the essay at its centre, the antecedents to its left and the succession to its right, with no lines between them. Choosing a title opens a short card of it. **Arrange**, for those who edit, lets each title be dragged to where it belongs; a title stays where it was put, and one that has not been put anywhere is found a place. **Start again** there forgets every place.
- **An antecedent** is a title, an author, a type, a link and its annotations, and its page shows no more than that. Margin notes are for what is written here and published.
- **Admins** have [Invitations](#invitations) when it is on, where someone is invited by a link an admin passes on, or by a text. Sub-admins do not, whatever they have been given.
- The **main admin** alone has **Send**, which writes to her group chats on Signal and WhatsApp, and alone sends texts about a piece. To everyone else, other admins included, those do not exist.
- Those who edit also say what the corpus says of a piece, from the form it was written or added with: its annotation (for the essay at the centre, its claims), the colour of its title, the letter set after it (**Superscript**: b, c) for a piece that is another's, whether it is **Show and Tell**, and whether it is **missionaria**. On the corpus they reach that form from **Edit** on a piece's card.

### Invitations

These are put away for now: the pages below are not there unless `INVITATIONS=on`, though a link that was already handed out is still taken up, and the texts about a piece are as they were. What follows is how they work when they are on.

**Invitations**, linked from the Members page, is where an admin invites someone, and it needs nothing set up. Give their name and press **Make their link**: the page shows a link that is theirs alone, to copy and send them however you reach them. Following it, they choose a sign-in name and a password, and that makes their account; they arrive at the essay at the centre of the corpus.

- **The link is shown once.** Only what it comes to is kept, so it cannot be shown again; **New link** on their row makes another, and ends the one before. A link is good for 90 days. After that it is void, no account was ever made, and they are invited again or not at all.
- **The list** is everyone who has been put down, in order, with where each stands: not invited yet, given a link, texted, taken up. A name can be put down without making a link, changed, moved, or taken off.
- **Who did what is on the record**: the admin portal's Activity says which admin put someone down, made their link or texted them, by name and never by number.
- **Only admins have the page.** To a member, and to a sub-admin whatever they have been given, it does not exist.

Someone can also be put down with a telephone number, and then the forum can text them their link. That part needs the setting up below, and until it is done the page says so and offers links alone.

- **The announcement** is texted, when an admin presses for it, to everyone on the list with a number who has not been invited, in the order of the list. Someone who holds a link an admin made for them is passed over, and can be texted by themselves.
- **Once more**, at a later milestone, to those who were texted and did not come. Nobody is texted a third time about an account, and nobody who has answered STOP is texted at all. A link made by hand is not counted: that limit is on texts.
- **Texts about a piece** are the main admin's alone to send, from **Text it** on a published piece, and go only to those who asked. Under **Preferences**, a member who came in with a number here has two boxes, both unchecked to begin with: texts for all posts, and texts for some. For each piece she chooses whether it goes to those who asked for all, or to those who asked for some as well.
- What each text says is written on the Invitations page, which also sends the announcement to a number of your own to see how it reads.

How the numbers are kept:

- Each is sealed in the database with a key the database does not hold, `NUMBERS_KEY`. The database alone, or a backup or snapshot of it, gives up no number.
- No page shows a number to anyone but an admin, and to an admin only its last four digits except on the page where it is changed. Sub-admins, members, the admin portal and the record of what was done never see one. Numbers are not written to what the forum logs.
- Removing someone from the list deletes their number, and so does emptying it where it is changed. A member's account does not hold it.
- **Keep a copy of `NUMBERS_KEY` somewhere that is not the server**, a password manager for instance. If it is lost or changed, every number kept so far is unreadable and has to be put in again.

To set up texting:

1. Make the key, and give it to the forum. On Fly.io: `fly secrets set NUMBERS_KEY="$(openssl rand -base64 48)"`. On a server of your own, the same value goes in `server/.env`. Read it back from where you made it and keep the copy; Fly does not show a secret again.
2. Open a Twilio account and buy a number (a new one, apart from anyone's own, costs about a dollar a month). Then `fly secrets set TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… TWILIO_FROM=+1…`.
3. **Register the number before the launch.** American carriers do not deliver texts from an ordinary number that has not been registered for it (Twilio calls this A2P 10DLC, and walks you through it in its console). Approval takes from a few days to a few weeks, so begin well ahead. A toll-free number is verified in a similar way.
4. On the Invitations page, send the announcement to your own number first.

Each text costs about a cent, and a long one is charged as several; the Invitations page says how many parts each will be. The forum knows that Twilio took a text, not that the telephone received it: Twilio's own console shows that.

### Send: one box for both chats

**Send** is a box for a thought, with pictures and files added by choosing, pasting or dropping them. Each chat it can reach has a checkbox, all of them checked to begin with, and what is sent goes to every one that is checked. Below the box is what was sent, the last 50, with how each went to each chat and a way to send again what did not go.

Neither Signal nor WhatsApp offers a way for a program to write to a group as a person. What they do offer is to make a program one of the account's own devices, as a laptop running the app is, and that is what this does:

- **Signal** through [signal-cli](https://github.com/AsamK/signal-cli), a program the forum runs. The container image includes it. On a server of your own, install it and see that `signal-cli --version` answers for the forum's user.
- **WhatsApp** through [Baileys](https://github.com/WhiskeySockets/Baileys), a library that `npm install` brings.

To set it up, on **Send**, then **The chats and their accounts**:

1. Link each account. The page shows a code; on the telephone that has the account, open *Linked devices* in Signal's or WhatsApp's settings and scan it. Have the page open on a screen other than that telephone. (WhatsApp can also be linked by a code typed into the telephone.)
2. Once linked, the page lists the account's groups. Choose the chat and add it. More chats, or other services, can be added later in the same way.

What to know about it:

- **The forum becomes a device on those accounts.** Like any linked device it is sent everything the account is sent. The forum reads none of it and keeps none of it, but whoever can get into the server could. The keys are in `signal/` and `whatsapp/` in the data folder.
- **WhatsApp does not permit clients other than its own**, and has restricted accounts that use them. Sending a few messages a day to a group one is already in is at the mild end of that, but it is a risk to the account, not only to the feature.
- **Either can stop working without warning** when Signal or WhatsApp changes something, until the program is updated. Signal turns away versions of signal-cli a few months old: raise `SIGNAL_CLI_VERSION` and its sum in the `Dockerfile` every couple of months and deploy. If an account stops being linked, the Send page says so, and it is linked again in the same way.
- **To undo it**, press *Unlink* on the chats page, and remove "Gesserit" under *Linked devices* on the telephone.

### Notifications

These are put away for now: **Preferences** has no place to turn them on, and nothing is sent unless `NOTIFICATIONS=on`. What follows is how they work when they are on. Nothing has to be set up for it: there is no account with Apple or Google, and no key to make. The forum makes its own key pair the first time it starts and keeps it in the database, and encrypts each notification to the browser it is for, so the service that carries it cannot read it.

Three things to know when running it:

- **It needs https**, which `forum.gesserit.org` has. On your own machine it works at `http://127.0.0.1:8787` in a browser that has a notification service (Chrome, Firefox, Edge, Safari).
- **The forum must be able to reach out** to the notification services over https (port 443). On Fly.io it can.
- **On an iPhone or iPad** the member first adds the forum to the Home Screen (Share, then “Add to Home Screen”); Apple allows notifications only to a site added in that way.

If the database is lost or replaced by an empty one, the key goes with it and every member turns notifications on again.

### Marks of who is reading

Nothing shown on a screen can be kept from being photographed or copied, so the forum makes what leaves it traceable instead. No page of the forum tells members so any more (the guide that did is gone), so it is for whoever invites a member to say:

- Every signed-in page is laid over with the reader's sign-in name, the day and the number of their sign-in, one step of brightness away from the page: too faint to be seen. A screenshot of any part of a page carries it. To read it off a screenshot, raise the contrast as far as it goes in any picture editor (or use Threshold, set just below the page's colour). It is lost in a photograph of a screen, and in a copy that has been compressed, as most pictures sent through a messaging app are.
- A picture fetched from the forum has `Gesserit: fetched by <name> on <day> (sign-in <number>)` written into the file's details (PNG, JPEG, GIF, SVG; not WebP or AVIF). The picture itself is unchanged.
- A member whose sign-in asks for more than 150 pages in a minute or 1500 in an hour is refused until the minute or hour is out, and it is noted under **Activity** in the admin portal.

## The admin portal

One command, from the top of the repository:

```sh
./portal
```

It opens in your browser, and does from there what the rest of this page does by hand:

| Page | What it is for |
|---|---|
| **Overview** | The steps from nothing to a forum at its own address, each with a button when it is the one to do: install `fly`, sign in to Fly.io (where you make the account and give it a card), create the app, deploy, add the first admin, connect the domain. Both forums at a glance. |
| **Fly.io** | The app's name and region, how it stands, deploy, restart, what it logged, its addresses, its volume and snapshots. |
| **Domain** | Tells Fly.io the forum's name, shows the DNS record to add where the domain is kept, and says when the name leads to the forum and the certificate is ready. |
| **Members** | Add someone, give a new password, make an admin or a member again, make a sub-admin and choose what they may do, name the main admin, sign someone out, remove and restore. |
| **Activity** | Who is signed in and from what browser; what members published, noted and said (titles, never the text); and the record of what was done to members, and by whom. |

Members and Activity are for either forum: **Fly.io**, once it is deployed, or **This machine** (`server/data/`). The portal manages the forum on this machine whether or not it is running.

It needs Node 24 or later (`brew install node`), and for Fly.io the `fly` program, which the Overview installs with Homebrew. `npm run portal` in `server/` starts it too. Ctrl+C in the terminal closes it.

What to know about it:

- **It runs only on your machine.** It listens on `127.0.0.1`, and answers only a browser opened with the link it prints, which carries a key made afresh each time it starts. It is not part of the forum and is not deployed with it.
- **It holds no secrets.** On Fly.io it runs `fly` exactly as you would at a terminal and shows each command and what it printed; `fly` keeps its own sign-in. For members it asks the forum (`server/bin/admin.mjs`, on Fly.io over `fly ssh console`). A password it issues is shown once and kept nowhere.
- **It changes two things on this machine**: `fly.toml` (the app's name, region and address, when you set them) and, when you manage the forum here, `server/data/`. Deploying publishes what is in the folder.
- **What it does to members is on the record** beside what admins do in the forum, as done "from the server".

| Setting | Default | What it is |
|---|---|---|
| `PORTAL_PORT` | `8790`, or the next free | Where the portal listens. |
| `PORTAL_OPEN` | on | `0` not to open the browser; the link is printed either way. |
| `FLYCTL` | found on the PATH | The `fly` program, if it is somewhere unusual. |

## Publish

### To git, which publishes the landing page

```sh
git add -A
git commit -m "What changed"
git push
```

GitHub Pages rebuilds www.gesserit.org within a minute or two. `_config.yml` keeps `server/`, `tools/` and the portal off that website, and `.gitignore` keeps the database, `.env` and `node_modules` out of git altogether.

If git asks who you are the first time:

```sh
git config --global user.name "Your Name"
git config --global user.email "you@example.org"
```

### The forum, on Fly.io

[Fly.io](https://fly.io) runs the forum straight from this folder: there is no machine to look after, it serves HTTPS by itself, and it photographs the database daily. Everything it needs to be told is in `fly.toml` and the `Dockerfile`. It costs a few dollars a month.

The [admin portal](#the-admin-portal) does all of the following with buttons. By hand, the first time:

```sh
brew install flyctl
fly auth login                    # opens your browser; Fly asks for a card
fly apps create gesserit-forum    # name taken? pick another, and put it in fly.toml as `app` too
fly deploy --ha=false
fly ssh console -C 'add-user --admin zan "Zan Huang"'     # prints your password, once
```

The forum is then at <https://gesserit-forum.fly.dev>, and members can sign in there. To give it its own name:

```sh
fly certs add forum.gesserit.org
```

That prints the DNS record to add wherever gesserit.org's DNS is kept (a `CNAME` from `forum` to `gesserit-forum.fly.dev`). `fly certs check forum.gesserit.org` says when the certificate is ready. Both addresses work from then on.

Each update:

```sh
fly deploy
```

Fly deploys what is in the folder, whether or not it has been pushed to git. The forum is away for a few seconds while it restarts; nothing members have written is touched, because that lives on a volume (`gesserit_data`) and not in what is deployed.

| Command | What it does |
|---|---|
| `fly logs` | What the forum says while it runs. |
| `fly status` | Whether it is up. |
| `fly ssh console -C 'add-user --reset <sign-in name>'` | A new password for someone, when no admin can sign in to give one. |
| `fly ssh console -C 'add-user --rename <sign-in name> "<New Name>"'` | Changes the name someone is shown by. |
| `fly volumes list`, then `fly volumes snapshots list <volume id>` | The daily snapshots, kept 14 days. `fly volumes create gesserit_data --snapshot-id <id>` makes a volume from one. |

If the first deploy leaves the address unanswered, see that it was given one: `fly ips list`, and if that is empty, `fly ips allocate-v6` and `fly ips allocate-v4 --shared`.

Diagrams are drawn there: the image includes LaTeX, which is most of its size. `fly deploy --build-arg DIAGRAMS=0` leaves it out. It includes signal-cli too, for [Send](#send-one-box-for-both-chats), which is another 400 MB; `--build-arg SIGNAL=0` leaves that out.

What must not be read by anyone is not in `fly.toml` but given to Fly as a secret, which restarts the forum with it set:

```sh
fly secrets set NUMBERS_KEY="$(openssl rand -base64 48)"
fly secrets set TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… TWILIO_FROM=+1…
```

[Invitations](#invitations) says what these are, and why to keep a copy of the first.

### The forum, on a server of your own: the first time

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

### The forum, on a server of your own: each update

After a `git push`, on the server:

```sh
cd /srv/gesserit/site
sudo -u gesserit -H git pull
sudo -u gesserit -H npm --prefix server ci --omit=dev
sudo systemctl restart gesserit-forum
```

`journalctl -u gesserit-forum -f` shows what it says while it runs.

### Backups, on a server of your own

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
- **Checked for you.** `npm test` includes `server/test/site.test.mjs`, which fails if either page reads a colour the palette lacks, if the vines are out of date, if a shared file has gone missing, if the database is no longer kept out of git and out of the image sent to Fly.io, or if `fly.toml` and the `Dockerfile` stop agreeing about the port and where the data is.
