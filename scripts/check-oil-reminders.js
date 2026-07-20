/**
 * Oil Change Reminder — automated odometer-based notifications for MyGeotab
 *
 * MULTI-DATABASE VERSION (plain numbered secrets — no JSON).
 *
 * Add databases by setting numbered environment secrets:
 *   DB1_DATABASE, DB1_USER, DB1_PASSWORD, DB1_EMAILTO   (+ optional DB1_LABEL,
 *                                                          DB1_INTERVAL, DB1_GROUP)
 *   DB2_DATABASE, DB2_USER, DB2_PASSWORD, DB2_EMAILTO
 *   DB3_...  and so on. The script scans DB1..DB20 and runs any that are set.
 *
 * SMTP creds + EMAIL_FROM are shared across all databases.
 *
 * For each database it authenticates, reads every vehicle's odometer, compares
 * to the last-notified value stored in AddInData, emails a digest for any
 * vehicle past its interval, and auto-resets that vehicle's counter.
 * No manual completion required.
 */

const nodemailer = require("nodemailer");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ADD_IN_ID = "aWI4NTRlNjItNzc5Ny0wOTB";

const UNITS = "mi"; // "mi" or "km" — match the Add-In HTML
const METERS_PER_UNIT = UNITS === "km" ? 1000 : 1609.344;

const DEFAULT_INTERVAL_MILES = 10000;
const DEFAULT_TARGET_GROUP_ID = "GroupCompanyId"; // whole fleet
const MAX_DATABASES = 20; // scans DB1..DB20

// ---------------------------------------------------------------------------
// Shared SMTP secrets
// ---------------------------------------------------------------------------
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ---------------------------------------------------------------------------
// Build the account list from numbered env vars
// ---------------------------------------------------------------------------
function loadAccounts() {
  const accounts = [];
  for (let i = 1; i <= MAX_DATABASES; i++) {
    const database = process.env[`DB${i}_DATABASE`];
    if (!database) continue; // slot not used
    accounts.push({
      label: process.env[`DB${i}_LABEL`] || database,
      database,
      user: process.env[`DB${i}_USER`],
      password: process.env[`DB${i}_PASSWORD`],
      emailTo: process.env[`DB${i}_EMAILTO`],
      intervalMiles: Number(process.env[`DB${i}_INTERVAL`]) || DEFAULT_INTERVAL_MILES,
      targetGroupId: process.env[`DB${i}_GROUP`] || DEFAULT_TARGET_GROUP_ID,
    });
  }
  return accounts;
}

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
// Data helpers
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
  return data[0].data;
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
  const entity = { addInId: ADD_IN_ID, groups: [{ id: "GroupCompanyId" }], details };
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
  const label = account.label;
  console.log(`\n=== ${label} (${account.database}) ===`);

  const client = makeClient();
  const server = await client.authenticate(account.database, account.user, account.password);
  console.log(`  Authenticated on ${server}`);

  const [devices, state] = await Promise.all([
    getDevices(client, account.targetGroupId),
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
          intervalMiles: account.intervalMiles,
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
      (details.intervalMiles || account.intervalMiles) * METERS_PER_UNIT;
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
      console.log(`  ${due.length} vehicle(s) due but no DB email set — skipping email`);
    }
  } else {
    console.log(`  No vehicles due. No email sent.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No databases configured. Set DB1_DATABASE, DB1_USER, DB1_PASSWORD, DB1_EMAILTO (and DB2_* etc)."
    );
  }
  console.log(`Found ${accounts.length} database(s) configured.`);

  let hadError = false;
  for (const account of accounts) {
    try {
      await processAccount(account);
    } catch (err) {
      hadError = true;
      console.error(`  ERROR on ${account.label}: ${err.message}`);
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
