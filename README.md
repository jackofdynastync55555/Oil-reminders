# Oil Change Reminders for MyGeotab

Automatic distance-based oil change notifications with self-resetting counters. No work orders, no manual completion — a vehicle crosses its interval, an email goes out, the counter resets itself, and the cycle repeats.

Two pieces, one shared data store:

- **`scripts/check-oil-reminders.js`** — runs daily on GitHub Actions (free). Checks every vehicle's odometer, emails a digest when vehicles hit their interval, and resets their counters automatically.
- **`addin/oil-reminders.html`** — a MyGeotab Add-In page. Shows every vehicle's progress toward its next reminder, and lets you change intervals, turn reminders on/off per vehicle, or manually reset a counter ("Mark serviced now").

Both read and write the same records in MyGeotab's built-in `AddInData` storage, so there is no external database.

---

## How the reset works

Each vehicle has one stored value: the odometer reading at its last reminder. Every day the script checks:

```
current odometer − last notified odometer >= interval?
```

If yes, the vehicle goes in the digest email and its "last notified" value is snapped to the current odometer. That's the whole reset. Nothing to complete, nothing to click.

First run behavior: the first time the script sees a vehicle, it records the current odometer as the baseline and does **not** notify. The first reminder comes one full interval later. If a vehicle just had its oil changed, the baseline is already correct. If one is mid-cycle, open the Add-In and hit "Mark serviced now" after its next actual oil change to sync it up.

---

## Setup (about 20 minutes)

### 1. AddInId — DONE

Already generated and inserted into both files: `aWI4NTRlNjItNzc5Ny0wOTB`. Nothing to do. (For future add-ins: it's a base64-encoded GUID, URL-safe, prefixed with "a", 23 chars — see the Storage API page on developers.geotab.com.)

### 2. Edit the config at the top of the script

In `scripts/check-oil-reminders.js`:

| Setting | What it does |
|---|---|
| `TARGET_GROUP_ID` | Which group of vehicles gets reminders. `"GroupCompanyId"` = whole fleet, or a specific group id (find it in the URL when viewing the group in MyGeotab). |
| `DEFAULT_INTERVAL_MILES` | Default reminder distance (10000). Per-vehicle overrides are set in the Add-In. |
| `UNITS` | `"mi"` or `"km"`. Set the same value in the Add-In HTML. |

### 3. Push this repo to GitHub

**Option A — command line (recommended):**

```bash
cd oil-reminders            # the unzipped folder
git init
git add .
git commit -m "Oil change reminder automation + add-in"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/oil-reminders.git
git push -u origin main
```

Create the empty repo first at github.com → New repository → name it `oil-reminders` → **Private** → don't add a README (you already have one).

**Option B — web upload (no git needed):**

github.com → New repository → `oil-reminders` → Private → create. Then "uploading an existing file" link → drag the folder contents in → Commit. One catch: the web uploader can silently skip the hidden `.github` folder depending on how you drag it — after committing, verify `.github/workflows/oil-reminders.yml` exists in the repo. If it's missing, use "Add file → Create new file", type `.github/workflows/oil-reminders.yml` as the name, and paste the file contents.

Final structure must be:

```
.github/workflows/oil-reminders.yml
scripts/check-oil-reminders.js
addin/oil-reminders.html
addin/config.json
README.md
```

### 4. Add GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `GEOTAB_DATABASE` | Customer database name |
| `GEOTAB_USER` | Service account email (recommend a dedicated MyGeotab user for this) |
| `GEOTAB_PASSWORD` | Its password |
| `SMTP_HOST` | e.g. `smtp.gmail.com` or your mail provider |
| `SMTP_PORT` | `587` (or `465`) |
| `SMTP_USER` | SMTP login |
| `SMTP_PASS` | SMTP password (for Gmail: an App Password, not the account password) |
| `EMAIL_FROM` | e.g. `fleet-alerts@dynastycommunications.com` |
| `EMAIL_TO` | Recipient(s), comma-separated |

### 5. Test the script

Actions tab → "Oil Change Reminders" → **Run workflow**. Check the log — you should see every vehicle listed with its baseline being set. Run it again and you'll see "X mi until next reminder" lines. No email sends until a vehicle actually crosses its interval.

### 6. Publish the Add-In via GitHub Pages

Repo → Settings → Pages → deploy from branch `main`, root folder. Your Add-In URL becomes:

```
https://YOUR-USERNAME.github.io/YOUR-REPO/addin/oil-reminders.html
```

Put that URL into `addin/config.json`.

### 7. Register the Add-In in MyGeotab

In the customer database: **System → Settings → Add-Ins → New Add-In**, paste the contents of `addin/config.json`, save, and refresh. "Oil Change Reminders" appears under the Activity menu.

---

## Daily operation

- The script runs at 11:00 UTC (~6–7 AM Eastern) every day. Adjust the cron in `.github/workflows/oil-reminders.yml` if needed.
- Emails are a single digest listing all vehicles due that day.
- Vehicles with no odometer data (asset trackers, unplugged devices) are skipped and noted in the log.
- New vehicles added to the group are picked up automatically on the next run.

## Notes and gotchas

- **Odometer accuracy**: `DiagnosticOdometerAdjustmentId` is the adjusted odometer. If a customer's devices haven't had odometer synced/calibrated, calibrate in MyGeotab first (Vehicle Edit → Odometer) or readings may be off from the dash.
- **Daily polling is the resolution**: a vehicle that crosses its interval at 9 AM gets the email the next morning. For oil changes that's fine; tighten the cron if a customer wants faster.
- **Service account**: use a dedicated MyGeotab user with a role that can read Devices/StatusData and read/write AddInData, so the automation isn't tied to a person's login.
- **Multiple customers**: this design is one repo per customer database. To serve several databases from one repo, loop the auth/check over a list of credentials.

## Ideas for turning this into a full maintenance Add-In

- Add more reminder types per vehicle (tire rotation, brake inspection) as extra entries in the same AddInData details object
- Engine-hours-based intervals for equipment (swap the diagnostic to `DiagnosticEngineHoursAdjustmentId`)
- A history log of past reminders per vehicle
- In-app overdue banner + email
