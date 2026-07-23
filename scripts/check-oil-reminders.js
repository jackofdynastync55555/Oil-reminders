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
const CUSTOM_ADD_IN_ID = "ajE5ODViNGYtOTJmZC0wODk"; // custom reminders store

const UNITS = "mi"; // "mi" or "km" — match the Add-In HTML
const METERS_PER_UNIT = UNITS === "km" ? 1000 : 1609.344;

const DEFAULT_INTERVAL_MILES = 5000;
const DEFAULT_TARGET_GROUP_ID = "GroupCompanyId"; // whole fleet
const MAX_DATABASES = 20; // scans DB1..DB20

// ---------------------------------------------------------------------------
// Shared SMTP secrets
// ---------------------------------------------------------------------------
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;

const transporterConfig = {
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
};
// Only attach auth if both are present — otherwise nodemailer tries PLAIN with
// empty creds and throws "Missing credentials for PLAIN".
if (SMTP_USER && SMTP_PASS) {
  transporterConfig.auth = { user: SMTP_USER, pass: SMTP_PASS };
}
const transporter = nodemailer.createTransport(transporterConfig);

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
// Only real GO-device vehicles (skips manually-created test/placeholder assets)
function isRealGoDevice(x) {
  const sn = (x.serialNumber || "").trim();
  const hasSerial = sn.length > 0 && !/^0+$/.test(sn) && sn.toUpperCase() !== "NOSERIALNUMBER";
  const dt = (x.deviceType || "").toLowerCase();
  const isCustom = dt.indexOf("custom") >= 0 || dt.indexOf("untracked") >= 0;
  return hasSerial && !isCustom;
}

async function getDevices(client, targetGroupId) {
  const devices = await client.call("Get", {
    typeName: "Device",
    search: { groups: [{ id: targetGroupId }] },
  });
  const now = new Date();
  return devices.filter(
    (d) => (!d.activeTo || new Date(d.activeTo) > now) && isRealGoDevice(d)
  );
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

// Oil life remaining (%) from the vehicle's own monitor. Matched by diagnostic
// name since the id isn't a fixed KnownId across vehicles. Returns null if absent.
const oilLifeDiagCache = { ids: null };
async function getOilLifePct(client, deviceId) {
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date().toISOString();
  try {
    const data = await client.call("Get", {
      typeName: "StatusData",
      resultsLimit: 500,
      search: { deviceSearch: { id: deviceId }, fromDate: from, toDate: to },
    });
    if (!data || !data.length) return null;
    // Need diagnostic names; fetch/caches names for ids we see
    const ids = {};
    data.forEach((sd) => { if (sd.diagnostic && sd.diagnostic.id) ids[sd.diagnostic.id] = true; });
    const idList = Object.keys(ids);
    const nameById = {};
    for (const id of idList) {
      const dr = await client.call("Get", { typeName: "Diagnostic", search: { id } });
      nameById[id] = dr && dr[0] ? (dr[0].name || dr[0].code || id) : id;
    }
    // latest value whose name matches oil life
    let best = null;
    data.forEach((sd) => {
      const nm = (nameById[sd.diagnostic && sd.diagnostic.id] || "").toLowerCase();
      if (/engine oil life remaining|oil life/.test(nm)) {
        const t = sd.dateTime ? new Date(sd.dateTime).getTime() : 0;
        if (!best || t > best.t) best = { t, v: sd.data };
      }
    });
    return best ? best.v : null;
  } catch (e) {
    return null;
  }
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

async function sendServicedConfirmation(label, emailTo, servicedVehicles) {
  const lines = servicedVehicles.map(
    (v) => `\u2022 ${v.name} — marked serviced at ${Math.round(v.atUnits).toLocaleString()} ${UNITS}`
  );
  const body = [
    `The following vehicle(s) were marked as serviced and their oil change`,
    `counters were reset:`,
    ``,
    ...lines,
    ``,
    `The next reminder for each will be sent after it travels its interval again.`,
    ``,
    `— Automated confirmation from Dynasty Communications fleet monitoring`,
  ].join("\n");

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: emailTo,
    subject: `Oil change reset confirmed: ${servicedVehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  Serviced-confirmation sent to ${emailTo} (${servicedVehicles.length} vehicles)`);
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

  const dueDigest = [];     // reached interval — auto-reset + unconfirmed warning
  const upcoming500 = [];   // 500 mi out
  const serviced = [];      // vehicles flagged 'Mark serviced now' in the Add-In
  const odometerByDevice = {}; // for custom distance reminders

  for (const device of devices) {
    const odoMeters = await getOdometerMeters(client, device.id);
    odometerByDevice[device.id] = odoMeters;
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
    const remainingMeters = intervalMeters - sinceLast;
    const remainingUnits = remainingMeters / METERS_PER_UNIT;

    const STAGE_500 = 500 * METERS_PER_UNIT;
    if (!details.stagesSent) details.stagesSent = {}; // { s500 }

    if (sinceLast >= intervalMeters) {
      // Due: auto-reset + "may not have been serviced" warning
      const oilLife = await getOilLifePct(client, device.id);
      dueDigest.push({
        name: device.name,
        currentUnits: odoMeters / METERS_PER_UNIT,
        sinceLastUnits: sinceLast / METERS_PER_UNIT,
        intervalUnits: intervalMeters / METERS_PER_UNIT,
        oilLife: oilLife,
      });
      details.lastNotifiedMeters = odoMeters;
      details.lastNotifiedDate = new Date().toISOString();
      details.stagesSent = {}; // reset stage flags for the new cycle
      if (!details.history) details.history = [];
      details.history.push({ date: new Date().toISOString(), odoMeters: odoMeters, source: "auto", oilLife: oilLife });
      await saveState(client, existing, details);
      console.log(`    ${device.name}: DUE — auto-reset (service not confirmed)`);
    } else if (remainingMeters <= STAGE_500 && !details.stagesSent.s500) {
      const oilLife = await getOilLifePct(client, device.id);
      upcoming500.push({ name: device.name, remainingUnits: remainingUnits, oilLife: oilLife });
      details.stagesSent.s500 = true;
      await saveState(client, existing, details);
      console.log(`    ${device.name}: 500-${UNITS} reminder sent`);
    } else {
      console.log(`    ${device.name}: ${remainingUnits.toFixed(0)} ${UNITS} until due`);
    }
  }

  // Handle "Mark serviced now" confirmations flagged in the Add-In
  for (const [deviceId, entry] of state.entries()) {
    const d = entry.details;
    if (d && d.emailPending) {
      serviced.push({
        name: d.deviceName || deviceId,
        atUnits: (d.emailPendingOdoMeters != null ? d.emailPendingOdoMeters : d.lastNotifiedMeters) / METERS_PER_UNIT,
      });
      // Clear the flag so it only emails once
      const cleared = { ...d };
      delete cleared.emailPending;
      delete cleared.emailPendingReason;
      delete cleared.emailPendingOdoMeters;
      await saveState(client, entry, cleared);
    }
  }

  if (serviced.length > 0) {
    if (account.emailTo) {
      await sendServicedConfirmation(label, account.emailTo, serviced);
    } else {
      console.log(`  ${serviced.length} serviced confirmation(s) pending but no email set`);
    }
  }

  const to = account.emailTo;
  if (to) {
    if (upcoming500.length > 0) await sendStageEmail(label, to, "500", upcoming500);
    if (dueDigest.length > 0) await sendDueEmail(label, to, dueDigest);
  }
  if (!upcoming500.length && !dueDigest.length) {
    console.log(`  No oil reminders due this run.`);
  }

  // ---- Custom reminders (distance or time) --------------------------
  try {
    await processCustomReminders(client, account, label, odometerByDevice);
  } catch (e) {
    console.error(`  Custom reminders error on ${label}: ${e.message}`);
  }
}

// 500/100 upcoming reminder email
async function sendStageEmail(label, to, stage, vehicles) {
  const oilTxt = (v) => v.oilLife != null ? ` — oil life remaining: ${Math.round(v.oilLife)}%` : "";
  const lines = vehicles.map(
    (v) => `\u2022 ${v.name} — ${Math.round(v.remainingUnits)} ${UNITS} until oil change due${oilTxt(v)}`
  );
  const heading = stage === "500"
    ? `Oil service coming up (within 500 ${UNITS}):`
    : `Oil service due soon (within 250 ${UNITS}):`;
  const body = [heading, ``, ...lines, ``,
    `This is an advance reminder — no action needed in Geotab.`,
    `The system will track these automatically.`,
    ``, `— Automated reminder from Dynasty Communications fleet monitoring`].join("\n");
  await transporter.sendMail({
    from: EMAIL_FROM, to,
    subject: `Oil service ${stage === "500" ? "coming up" : "due soon"}: ${vehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  ${stage}-${UNITS} reminder email sent to ${to} (${vehicles.length})`);
}

// At-interval email: auto-reset happened, but service is NOT confirmed
async function sendDueEmail(label, to, vehicles) {
  const oilTxt = (v) => v.oilLife != null ? ` — oil life remaining: ${Math.round(v.oilLife)}%` : "";
  const lines = vehicles.map(
    (v) => `\u2022 ${v.name} — reached ${Math.round(v.intervalUnits).toLocaleString()} ${UNITS} interval at ${Math.round(v.currentUnits).toLocaleString()} ${UNITS}${oilTxt(v)}`
  );
  const body = [
    `The following vehicle(s) have reached their oil change interval and the`,
    `counter has been AUTO-RESET so tracking continues:`,
    ``,
    ...lines,
    ``,
    `IMPORTANT: Reaching the mileage does not confirm the oil was changed.`,
    `If any of these were NOT serviced, please schedule service now — the next`,
    `reminder for each vehicle will not fire until it travels another full interval.`,
    ``,
    `— Automated reminder from Dynasty Communications fleet monitoring`,
  ].join("\n");
  await transporter.sendMail({
    from: EMAIL_FROM, to,
    subject: `Oil interval reached (auto-reset): ${vehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  DUE/auto-reset email sent to ${to} (${vehicles.length})`);
}

// Reads the custom-reminder AddInData, checks each against odometer (mi) or
// elapsed days, emails the ones that are due, and resets their baseline.
async function processCustomReminders(client, account, label, odometerByDevice) {
  const records = await client.call("Get", {
    typeName: "AddInData",
    search: { addInId: CUSTOM_ADD_IN_ID },
  });

  // find the global default recipients record, if set
  let globalDefaultEmail = null;
  for (const rec of records) {
    const d = typeof rec.details === "string" ? JSON.parse(rec.details) : rec.details;
    if (d && d.settingsKey === "global") { globalDefaultEmail = d.defaultEmailTo || null; break; }
  }

  // due reminders grouped by resolved recipient list
  const byRecipient = {}; // recipientString -> [ {label, device, at} ]

  for (const rec of records) {
    const d = typeof rec.details === "string" ? JSON.parse(rec.details) : rec.details;
    if (!d || d.settingsKey === "global" || d.enabled === false || !d.deviceId) continue;

    let isDue = false;
    let atText = "";
    if (d.type === "days") {
      const start = d.baselineDate ? new Date(d.baselineDate).getTime() : Date.now();
      const elapsedDays = (Date.now() - start) / 86400000;
      if (elapsedDays >= d.interval) { isDue = true; atText = `${Math.round(elapsedDays)} days elapsed`; }
    } else {
      const odo = odometerByDevice ? odometerByDevice[d.deviceId] : null;
      if (odo != null && d.baselineMeters != null) {
        const since = (odo - d.baselineMeters) / METERS_PER_UNIT;
        if (since >= d.interval) { isDue = true; atText = `${Math.round(odo / METERS_PER_UNIT).toLocaleString()} ${UNITS}`; }
      }
    }

    if (isDue) {
      // resolve recipient: per-reminder override → global default → account default
      const recipient = (d.emailTo && d.emailTo.trim()) || globalDefaultEmail || account.emailTo || null;
      const key = recipient || "__none__";
      if (!byRecipient[key]) byRecipient[key] = [];
      byRecipient[key].push({ label: d.label || "Reminder", device: d.deviceName || d.deviceId, at: atText });

      // reset baseline + log history
      if (!d.history) d.history = [];
      const odo = odometerByDevice ? odometerByDevice[d.deviceId] : null;
      d.history.push({ date: new Date().toISOString(), odoMeters: d.type === "mi" ? odo : null, source: "auto" });
      if (d.type === "mi" && odo != null) d.baselineMeters = odo;
      d.baselineDate = new Date().toISOString();
      const entity = { id: rec.id, addInId: CUSTOM_ADD_IN_ID, groups: [{ id: "GroupCompanyId" }], details: d };
      await client.call("Set", { typeName: "AddInData", entity });
    }
  }

  const recipientKeys = Object.keys(byRecipient);
  if (!recipientKeys.length) { console.log(`  No custom reminders due.`); return; }

  for (const key of recipientKeys) {
    const items = byRecipient[key];
    if (key === "__none__") {
      console.log(`  ${items.length} custom reminder(s) due but no recipient resolved — skipping email`);
      continue;
    }
    const lines = items.map((c) => `\u2022 ${c.device} — ${c.label}${c.at ? " (" + c.at + ")" : ""}`);
    const body = [
      `The following custom maintenance reminder(s) are due:`,
      ``,
      ...lines,
      ``,
      `Counters have been reset automatically.`,
      ``,
      `— Automated reminder from Dynasty Communications fleet monitoring`,
    ].join("\n");
    // nodemailer accepts comma-separated recipients directly
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: key,
      subject: `Maintenance due: ${items.length} custom reminder(s)${label ? " — " + label : ""}`,
      text: body,
    });
    console.log(`  Custom reminder email sent to ${key} (${items.length})`);
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
