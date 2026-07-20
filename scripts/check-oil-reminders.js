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
 *//**
 * Oil Change Reminder — automated odometer-based notifications for MyGeotab
 *
 * MULTI-DATABASE VERSION.
 *
 * Runs on a schedule via GitHub Actions. For EACH database listed in the
 * GEOTAB_ACCOUNTS secret it:
 *   1. Authenticates to the MyGeotab API
 *   2. Pulls current odometer for every vehicle in that database's target group
 *   3. Compares against the last-notified odometer stored in AddInData
 *   4. If a vehicle has traveled >= its interval since the last notice,
 *      it's added to that database's digest email and its counter auto-resets
 *
 * No manual completion required. The "reset" is just bumping the stored
 * last-notified odometer to the current reading.
 *
 * State is stored in MyGeotab AddInData (scoped per database automatically),
 * so the companion Add-In UI (addin/oil-reminders.html) reads the same records.
 */

const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

// Same AddInId used in addin/oil-reminders.html. Safe to reuse across
// databases — AddInData is isolated per database.
const ADD_IN_ID = "aWI4NTRlNjItNzc5Ny0wOTB";

// "mi" or "km" — applies to all databases. Match the value in the Add-In HTML.
const UNITS = "mi";
const METERS_PER_UNIT = UNITS === "km" ? 1000 : 1609.344;

// Fallbacks used when an account object omits these fields
const DEFAULT_INTERVAL_MILES = 10000;
const DEFAULT_TARGET_GROUP_ID = "GroupCompanyId"; // whole fleet

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
// GEOTAB_ACCOUNTS is a JSON array. Each entry:
//   {
//     "label": "ABC Trucking",          // for logs/email only
//     "database": "abctrucking",
//     "user": "svc@dynastycommunications.com",
//     "password": "xxx",
//     "emailTo": "maintenance@abc.com",  // comma-separated ok
//     "intervalMiles": 10000,            // optional, defaults to 10000
//     "targetGroupId": "GroupCompanyId", // optional, defaults to whole fleet
//     "enabled": true                    // optional, defaults to true
//   }
//
// SMTP creds + EMAIL_FROM are shared across all accounts (one sending account).
const {
  GEOTAB_ACCOUNTS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
} = process.env;

// ---------------------------------------------------------------------------
// Shared email transporter (created once, reused for every account)
// ---------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ---------------------------------------------------------------------------
// Per-database MyGeotab JSON-RPC client
// ---------------------------------------------------------------------------
function makeClient() {
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

  return {
    async authenticate(database, user, password) {
      const result = await rpc("Authenticate", { database, userName: user, password });
      credentials = result.credentials;
      if (result.path && result.path !== "ThisServer") server = result.path;
      return server;
    },
    call: (method, params) => rpc(method, { ...params, credentials }),
  };
}

// ---------------------------------------------------------------------------
// Data helpers (take the client as an argument)
// ---------------------------------------------------------------------------

async function getDevices(client, targetGroupId) {
  const devices = await client.call("Get", {
    typeName: "Device",
    search: { groups: [{ id: targetGroupId }] },
  });
  const now = new Date();
  return devices.filter((d) => !d.activeTo || new Date(d.activeTo) > now);
}

async function getOdometerMeters(client, deviceId) {
  const now = new Date().toISOString();
  const data = await client.call("Get", {
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

async function getState(client) {
  const records = await client.call("Get", {
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

async function saveState(client, existing, details) {
  const entity = {
    addInId: ADD_IN_ID,
    groups: [{ id: "GroupCompanyId" }],
    details,
  };
  if (existing && existing.id) {
    entity.id = existing.id;
    await client.call("Set", { typeName: "AddInData", entity });
  } else {
    await client.call("Add", { typeName: "AddInData", entity });
  }
}

async function sendDigest(label, emailTo, dueVehicles) {
  const lines = dueVehicles.map(
    (v) =>
      `\u2022 ${v.name} — ${Math.round(v.currentUnits).toLocaleString()} ${UNITS} ` +
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
    to: emailTo,
    subject: `Oil change due: ${dueVehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  Digest sent to ${emailTo} (${dueVehicles.length} vehicles)`);
}

// ---------------------------------------------------------------------------
// Process ONE database
// ---------------------------------------------------------------------------
async function processAccount(account) {
  const label = account.label || account.database;
  const intervalMilesDefault = account.intervalMiles || DEFAULT_INTERVAL_MILES;
  const targetGroupId = account.targetGroupId || DEFAULT_TARGET_GROUP_ID;

  console.log(`\n=== ${label} (${account.database}) ===`);

  const client = makeClient();
  const server = await client.authenticate(
    account.database,
    account.user,
    account.password
  );
  console.log(`  Authenticated on ${server}`);

  const [devices, state] = await Promise.all([
    getDevices(client, targetGroupId),
    getState(client),
  ]);
  console.log(`  Checking ${devices.length} vehicle(s)…`);

  const due = [];

  for (const device of devices) {
    const odoMeters = await getOdometerMeters(client, device.id);
    if (odoMeters == null) {
      console.log(`    ${device.name}: no odometer data, skipping`);
      continue;
    }

    const existing = state.get(device.id);
    const details = existing
      ? { ...existing.details }
      : {
          deviceId: device.id,
          deviceName: device.name,
          lastNotifiedMeters: odoMeters,
          intervalMiles: intervalMilesDefault,
          enabled: true,
          lastNotifiedDate: null,
        };

    details.deviceName = device.name;

    if (!existing) {
      await saveState(client, null, details);
      console.log(
        `    ${device.name}: baseline set at ${(odoMeters / METERS_PER_UNIT).toFixed(0)} ${UNITS}`
      );
      continue;
    }

    if (details.enabled === false) {
      console.log(`    ${device.name}: reminders disabled, skipping`);
      continue;
    }

    const intervalMeters =
      (details.intervalMiles || intervalMilesDefault) * METERS_PER_UNIT;
    const sinceLast = odoMeters - details.lastNotifiedMeters;

    if (sinceLast >= intervalMeters) {
      due.push({
        name: device.name,
        currentUnits: odoMeters / METERS_PER_UNIT,
        sinceLastUnits: sinceLast / METERS_PER_UNIT,
      });
      details.lastNotifiedMeters = odoMeters;
      details.lastNotifiedDate = new Date().toISOString();
      await saveState(client, existing, details);
      console.log(`    ${device.name}: DUE — counter reset`);
    } else {
      const remaining = (intervalMeters - sinceLast) / METERS_PER_UNIT;
      console.log(`    ${device.name}: ${remaining.toFixed(0)} ${UNITS} until next reminder`);
    }
  }

  if (due.length > 0) {
    if (account.emailTo) {
      await sendDigest(label, account.emailTo, due);
    } else {
      console.log(`  ${due.length} vehicle(s) due but no emailTo set — skipping email`);
    }
  } else {
    console.log(`  No vehicles due. No email sent.`);
  }
}

// ---------------------------------------------------------------------------
// Main — loop over all accounts
// ---------------------------------------------------------------------------
async function main() {
  let accounts;
  try {
    accounts = JSON.parse(GEOTAB_ACCOUNTS);
  } catch (e) {
    throw new Error(
      "GEOTAB_ACCOUNTS secret is not valid JSON. Check for missing commas/quotes."
    );
  }
  if (!Array.isArray(accounts)) {
    throw new Error("GEOTAB_ACCOUNTS must be a JSON array of account objects.");
  }

  const active = accounts.filter((a) => a.enabled !== false);
  console.log(`Loaded ${accounts.length} account(s), ${active.length} active.`);

  let hadError = false;
  for (const account of active) {
    try {
      await processAccount(account);
    } catch (err) {
      hadError = true;
      console.error(`  ERROR on ${account.label || account.database}: ${err.message}`);
    }
  }

  if (hadError) {
    throw new Error("One or more databases failed — see logs above.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


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
