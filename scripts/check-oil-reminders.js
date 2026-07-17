/**
 * Oil Change Reminder — automated odometer-based notifications for MyGeotab
 *
 * What it does (runs on a schedule via GitHub Actions):
 *   1. Authenticates to the MyGeotab API
 *   2. Pulls current odometer for every vehicle in the target group
 *   3. Compares against the last-notified odometer stored in AddInData
 *   4. If a vehicle has traveled >= its interval since the last notice,
 *      it's added to a digest email and its counter auto-resets
 *
 * No manual completion required. The "reset" is just bumping the stored
 * last-notified odometer to the current reading.
 *
 * State is stored in MyGeotab AddInData so the companion Add-In UI
 * (addin/oil-reminders.html) can read and edit the same records.
 */

const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// CONFIG — edit these
// ---------------------------------------------------------------------------

// Generate your own AddInId here (required, 30 seconds):
// https://geotab.github.io/sdk/software/guides/addin-storage/
// Then use the SAME value in addin/oil-reminders.html
const ADD_IN_ID = "aWI4NTRlNjItNzc5Ny0wOTB";

// The MyGeotab group whose vehicles get reminders.
// "GroupCompanyId" = entire fleet. Or use a specific group id like "b2C61".
const TARGET_GROUP_ID = "GroupCompanyId";

// Default reminder interval in miles (per-vehicle overrides can be set in the Add-In UI)
const DEFAULT_INTERVAL_MILES = 10000;

// Set to "km" if the customer thinks in kilometers. Affects display + intervals.
const UNITS = "mi"; // "mi" or "km"

// ---------------------------------------------------------------------------
// Secrets come from environment variables (GitHub Actions secrets)
// ---------------------------------------------------------------------------
const {
  GEOTAB_DATABASE,
  GEOTAB_USER,
  GEOTAB_PASSWORD,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_TO, // comma-separated list is fine
} = process.env;

const METERS_PER_UNIT = UNITS === "km" ? 1000 : 1609.344;

// ---------------------------------------------------------------------------
// Minimal MyGeotab JSON-RPC client (no SDK dependency)
// ---------------------------------------------------------------------------
let server = "my.geotab.com";
let credentials = null;

async function rpc(method, params) {
  const res = await fetch(`https://${server}/apiv1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(
      `${method} failed: ${json.error.message || JSON.stringify(json.error)}`
    );
  }
  return json.result;
}

async function authenticate() {
  const result = await rpc("Authenticate", {
    database: GEOTAB_DATABASE,
    userName: GEOTAB_USER,
    password: GEOTAB_PASSWORD,
  });
  credentials = result.credentials;
  if (result.path && result.path !== "ThisServer") {
    server = result.path;
  }
  console.log(`Authenticated to ${GEOTAB_DATABASE} on ${server}`);
}

const call = (method, params) => rpc(method, { ...params, credentials });

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

async function getDevices() {
  const devices = await call("Get", {
    typeName: "Device",
    search: { groups: [{ id: TARGET_GROUP_ID }] },
  });
  // Skip historical/archived devices
  const now = new Date();
  return devices.filter(
    (d) => !d.activeTo || new Date(d.activeTo) > now
  );
}

async function getOdometerMeters(deviceId) {
  // fromDate == toDate == now returns the latest interpolated value
  const now = new Date().toISOString();
  const data = await call("Get", {
    typeName: "StatusData",
    search: {
      deviceSearch: { id: deviceId },
      diagnosticSearch: { id: "DiagnosticOdometerAdjustmentId" },
      fromDate: now,
      toDate: now,
    },
  });
  if (!data || data.length === 0 || data[0].data == null) return null;
  return data[0].data; // meters
}

async function getState() {
  // One AddInData record per vehicle:
  // details = { deviceId, lastNotifiedMeters, intervalMiles, enabled, lastNotifiedDate }
  const records = await call("Get", {
    typeName: "AddInData",
    search: { addInId: ADD_IN_ID },
  });
  const byDevice = new Map();
  for (const rec of records) {
    const details =
      typeof rec.details === "string" ? JSON.parse(rec.details) : rec.details;
    if (details && details.deviceId) {
      byDevice.set(details.deviceId, { id: rec.id, details });
    }
  }
  return byDevice;
}

async function saveState(existing, details) {
  const entity = {
    addInId: ADD_IN_ID,
    groups: [{ id: "GroupCompanyId" }],
    details,
  };
  if (existing && existing.id) {
    entity.id = existing.id;
    await call("Set", { typeName: "AddInData", entity });
  } else {
    await call("Add", { typeName: "AddInData", entity });
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function sendDigest(dueVehicles) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const lines = dueVehicles.map(
    (v) =>
      `• ${v.name} — ${Math.round(v.currentUnits).toLocaleString()} ${UNITS} ` +
      `(${Math.round(v.sinceLastUnits).toLocaleString()} ${UNITS} since last reminder)`
  );

  const body = [
    `The following vehicle(s) have reached their oil change interval:`,
    ``,
    ...lines,
    ``,
    `Counters have been reset automatically. The next reminder for each`,
    `vehicle will be sent after it travels its configured interval again.`,
    ``,
    `— Automated reminder from Dynasty Communications fleet monitoring`,
  ].join("\n");

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `Oil change due: ${dueVehicles.length} vehicle(s)`,
    text: body,
  });
  console.log(`Digest sent to ${EMAIL_TO} (${dueVehicles.length} vehicles)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await authenticate();

  const [devices, state] = await Promise.all([getDevices(), getState()]);
  console.log(`Checking ${devices.length} vehicle(s)…`);

  const due = [];

  for (const device of devices) {
    const odoMeters = await getOdometerMeters(device.id);
    if (odoMeters == null) {
      console.log(`  ${device.name}: no odometer data, skipping`);
      continue;
    }

    const existing = state.get(device.id);
    const details = existing
      ? { ...existing.details }
      : {
          deviceId: device.id,
          deviceName: device.name,
          lastNotifiedMeters: odoMeters, // baseline = current on first sight
          intervalMiles: DEFAULT_INTERVAL_MILES,
          enabled: true,
          lastNotifiedDate: null,
        };

    // Keep the display name fresh
    details.deviceName = device.name;

    if (!existing) {
      // First time seeing this vehicle — set the baseline, don't notify
      await saveState(null, details);
      console.log(
        `  ${device.name}: baseline set at ${(odoMeters / METERS_PER_UNIT).toFixed(0)} ${UNITS}`
      );
      continue;
    }

    if (details.enabled === false) {
      console.log(`  ${device.name}: reminders disabled, skipping`);
      continue;
    }

    const intervalMeters =
      (details.intervalMiles || DEFAULT_INTERVAL_MILES) * METERS_PER_UNIT;
    const sinceLast = odoMeters - details.lastNotifiedMeters;

    if (sinceLast >= intervalMeters) {
      due.push({
        name: device.name,
        currentUnits: odoMeters / METERS_PER_UNIT,
        sinceLastUnits: sinceLast / METERS_PER_UNIT,
      });
      // Auto-reset: snap to actual current odometer so intervals stay honest
      details.lastNotifiedMeters = odoMeters;
      details.lastNotifiedDate = new Date().toISOString();
      await saveState(existing, details);
      console.log(`  ${device.name}: DUE — counter reset`);
    } else {
      const remaining = (intervalMeters - sinceLast) / METERS_PER_UNIT;
      console.log(
        `  ${device.name}: ${remaining.toFixed(0)} ${UNITS} until next reminder`
      );
    }
  }

  if (due.length > 0) {
    await sendDigest(due);
  } else {
    console.log("No vehicles due. No email sent.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
