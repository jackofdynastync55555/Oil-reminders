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
const zlib = require("zlib");

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
// SINGLE SEND POINT
// ---------------------------------------------------------------------------
// Every email in this script goes through deliver(). To move to a different
// email service later (Amazon SES, SendGrid, SMTP.com, Postmark, etc.), you
// only change what's inside this function — nothing else in the file touches
// the transport. Two common ways to swap:
//   1) Stay on SMTP: just point SMTP_HOST/PORT/USER/PASS at the new provider's
//      SMTP endpoint. No code change needed.
//   2) Use a provider's native transport: swap the transporter above, e.g.
//        const transporter = nodemailer.createTransport({ SES: sesClient });
//      or install their nodemailer transport and drop it in here.
// `to` accepts a comma-separated string of one or more recipients.
async function deliver({ to, subject, text }) {
  return transporter.sendMail({ from: EMAIL_FROM, to, subject, text });
}

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

// The Add-In's fleet-wide settings live in the custom store as a single record
// with settingsKey === "global". It holds the default recipients, the
// auto-reset overrides (Settings tab) and the scheduled report config
// (Reporting tab). Returns the record plus its id so we can write back.
const DEFAULT_SETTINGS = {
  settingsKey: "global",
  defaultEmailTo: null,
  autoResetOil: true,     // false => oil reminders stay due until marked serviced
  autoResetCustom: true,  // false => custom reminders stay due until marked done
  report: null,
};

async function getGlobalSettings(client) {
  try {
    const records = await client.call("Get", {
      typeName: "AddInData",
      search: { addInId: CUSTOM_ADD_IN_ID },
    });
    for (const rec of records) {
      const d = typeof rec.details === "string" ? JSON.parse(rec.details) : rec.details;
      if (d && d.settingsKey === "global") {
        return { id: rec.id, details: { ...DEFAULT_SETTINGS, ...d } };
      }
    }
  } catch (e) {
    console.log(`  Could not read fleet settings: ${e.message}`);
  }
  return { id: null, details: { ...DEFAULT_SETTINGS } };
}

async function saveGlobalSettings(client, settingsRec) {
  const entity = {
    addInId: CUSTOM_ADD_IN_ID,
    groups: [{ id: "GroupCompanyId" }],
    details: settingsRec.details,
  };
  if (settingsRec.id) {
    entity.id = settingsRec.id;
    await client.call("Set", { typeName: "AddInData", entity });
  } else {
    settingsRec.id = await client.call("Add", { typeName: "AddInData", entity });
  }
}

// Resolution order (same as the custom-reminder path):
//   per-vehicle emailTo → fleet default → database default (DBn_EMAILTO) → none
function resolveRecipient(perVehicle, globalDefault, accountDefault) {
  const pv = perVehicle && String(perVehicle).trim();
  return pv || globalDefault || accountDefault || null;
}

// Groups a list of items by their resolved recipient string.
// Returns a Map: recipientString -> [items] (items with no recipient go under "__none__").
function bucketByRecipient(items, globalDefault, accountDefault) {
  const buckets = new Map();
  for (const it of items) {
    const to = resolveRecipient(it.emailTo, globalDefault, accountDefault);
    const key = to || "__none__";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  return buckets;
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

  await deliver({
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

  const settingsRec = await getGlobalSettings(client);
  const settings = settingsRec.details;
  const globalDefaultEmail = (settings.defaultEmailTo && settings.defaultEmailTo.trim()) || null;
  const autoResetOil = settings.autoResetOil !== false;
  const autoResetCustom = settings.autoResetCustom !== false;
  if (!autoResetOil) console.log(`  Manual mode: oil reminders will NOT auto-reset`);
  if (!autoResetCustom) console.log(`  Manual mode: custom reminders will NOT auto-reset`);

  const dueDigest = [];     // reached interval — auto-reset + unconfirmed warning
  const awaitingOil = [];   // reached interval in manual mode — awaiting confirmation
  const upcoming500 = [];   // 500 mi out
  const serviced = [];      // vehicles flagged 'Mark serviced now' in the Add-In
  const odometerByDevice = {}; // for custom distance reminders
  const reportRows = [];    // one entry per vehicle, feeds the scheduled Excel report

  for (const device of devices) {
    const odoMeters = await getOdometerMeters(client, device.id);
    odometerByDevice[device.id] = odoMeters;
    if (odoMeters == null) {
      console.log(`    ${device.name}: no odometer data, skipping`);
      reportRows.push({
        deviceId: device.id, name: device.name, status: "No odometer data",
        remainingUnits: null, odoUnits: null,
      });
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
      reportRows.push({
        deviceId: device.id, name: device.name, status: "On track",
        remainingUnits: details.intervalMiles || account.intervalMiles,
        odoUnits: odoMeters / METERS_PER_UNIT,
      });
      continue;
    }

    if (details.enabled === false) {
      console.log(`    ${device.name}: reminders disabled, skipping`);
      reportRows.push({
        deviceId: device.id, name: device.name, status: "Reminders off",
        remainingUnits: null, odoUnits: odoMeters / METERS_PER_UNIT,
      });
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
      const oilLife = await getOilLifePct(client, device.id);
      if (autoResetOil) {
        // Auto mode: reset the counter so tracking continues, and warn that
        // reaching the mileage is not the same as the oil having been changed.
        dueDigest.push({
          name: device.name,
          currentUnits: odoMeters / METERS_PER_UNIT,
          sinceLastUnits: sinceLast / METERS_PER_UNIT,
          intervalUnits: intervalMeters / METERS_PER_UNIT,
          oilLife: oilLife,
          emailTo: details.emailTo || null,
        });
        details.lastNotifiedMeters = odoMeters;
        details.lastNotifiedDate = new Date().toISOString();
        details.stagesSent = {}; // reset stage flags for the new cycle
        if (!details.history) details.history = [];
        details.history.push({ date: new Date().toISOString(), odoMeters: odoMeters, source: "auto", oilLife: oilLife });
        await saveState(client, existing, details);
        existing.details = details; // keep the map fresh — the emailPending sweep below writes from it
        console.log(`    ${device.name}: DUE — auto-reset (service not confirmed)`);
      } else {
        // Manual mode: leave the counter alone. The vehicle stays due and keeps
        // showing as overdue until someone hits "Mark serviced now" in the
        // Add-In. dueNotified stops it emailing on every single run; the
        // marked-serviced sweep clears that flag for the next cycle.
        if (!details.dueNotified) {
          awaitingOil.push({
            name: device.name,
            currentUnits: odoMeters / METERS_PER_UNIT,
            overdueUnits: (sinceLast - intervalMeters) / METERS_PER_UNIT,
            intervalUnits: intervalMeters / METERS_PER_UNIT,
            oilLife: oilLife,
            emailTo: details.emailTo || null,
          });
          details.dueNotified = true;
          details.dueNotifiedDate = new Date().toISOString();
          await saveState(client, existing, details);
          existing.details = details;
          console.log(`    ${device.name}: DUE — awaiting manual confirmation (no reset)`);
        } else {
          console.log(`    ${device.name}: still overdue, awaiting manual confirmation (already notified)`);
        }
      }
      reportRows.push({
        deviceId: device.id, name: device.name,
        status: autoResetOil ? "Due now" : "Overdue — awaiting confirmation",
        remainingUnits: remainingUnits, odoUnits: odoMeters / METERS_PER_UNIT,
      });
    } else if (remainingMeters <= STAGE_500 && !details.stagesSent.s500) {
      const oilLife = await getOilLifePct(client, device.id);
      upcoming500.push({ name: device.name, remainingUnits: remainingUnits, oilLife: oilLife, emailTo: details.emailTo || null });
      details.stagesSent.s500 = true;
      await saveState(client, existing, details);
      existing.details = details; // keep the map fresh — see note above
      console.log(`    ${device.name}: 500-${UNITS} reminder sent`);
      reportRows.push({
        deviceId: device.id, name: device.name, status: "Due soon",
        remainingUnits: remainingUnits, odoUnits: odoMeters / METERS_PER_UNIT,
      });
    } else {
      console.log(`    ${device.name}: ${remainingUnits.toFixed(0)} ${UNITS} until due`);
      reportRows.push({
        deviceId: device.id, name: device.name,
        status: remainingMeters <= STAGE_500 ? "Due soon" : "On track",
        remainingUnits: remainingUnits, odoUnits: odoMeters / METERS_PER_UNIT,
      });
    }
  }

  // Handle "Mark serviced now" confirmations flagged in the Add-In
  for (const [deviceId, entry] of state.entries()) {
    const d = entry.details;
    if (d && d.emailPending) {
      serviced.push({
        name: d.deviceName || deviceId,
        atUnits: (d.emailPendingOdoMeters != null ? d.emailPendingOdoMeters : d.lastNotifiedMeters) / METERS_PER_UNIT,
        emailTo: d.emailTo || null,
      });
      // Clear the flag so it only emails once. dueNotified also goes, so the
      // next time this vehicle passes its interval it notifies again.
      const cleared = { ...d };
      delete cleared.emailPending;
      delete cleared.emailPendingReason;
      delete cleared.emailPendingOdoMeters;
      delete cleared.dueNotified;
      delete cleared.dueNotifiedDate;
      await saveState(client, entry, cleared);
      entry.details = cleared;
      console.log(`    ${cleared.deviceName || deviceId}: marked-serviced confirmation queued`);
    }
  }
  if (serviced.length) console.log(`  ${serviced.length} marked-serviced confirmation(s) to send`);

  // Send one digest per resolved recipient. A vehicle's recipient is:
  //   its own emailTo (set per-asset or bulk-per-group in the Add-In)
  //   → the fleet default (settingsKey=global) → DBn_EMAILTO → none.
  // Vehicles sharing a recipient are combined into a single email to that address.
  for (const [to, items] of bucketByRecipient(serviced, globalDefaultEmail, account.emailTo)) {
    if (to === "__none__") { console.log(`  ${items.length} serviced confirmation(s) pending but no recipient resolved`); continue; }
    await sendServicedConfirmation(label, to, items);
  }
  for (const [to, items] of bucketByRecipient(upcoming500, globalDefaultEmail, account.emailTo)) {
    if (to === "__none__") { console.log(`  ${items.length} upcoming reminder(s) but no recipient resolved`); continue; }
    await sendStageEmail(label, to, "500", items);
  }
  for (const [to, items] of bucketByRecipient(dueDigest, globalDefaultEmail, account.emailTo)) {
    if (to === "__none__") { console.log(`  ${items.length} due reminder(s) but no recipient resolved`); continue; }
    await sendDueEmail(label, to, items);
  }
  for (const [to, items] of bucketByRecipient(awaitingOil, globalDefaultEmail, account.emailTo)) {
    if (to === "__none__") { console.log(`  ${items.length} overdue reminder(s) but no recipient resolved`); continue; }
    await sendAwaitingConfirmationEmail(label, to, items);
  }
  if (!upcoming500.length && !dueDigest.length && !awaitingOil.length) {
    console.log(`  No oil reminders due this run.`);
  }

  // ---- Custom reminders (distance or time) --------------------------
  let customReportRows = {};
  try {
    customReportRows = await processCustomReminders(
      client, account, label, odometerByDevice, globalDefaultEmail, autoResetCustom
    );
  } catch (e) {
    console.error(`  Custom reminders error on ${label}: ${e.message}`);
  }

  // ---- Scheduled Excel report ---------------------------------------
  try {
    await maybeSendReport(client, account, label, settingsRec, reportRows, customReportRows, devices);
  } catch (e) {
    console.error(`  Report error on ${label}: ${e.message}`);
  }
}

// Manual mode: interval reached but the counter was deliberately NOT reset.
async function sendAwaitingConfirmationEmail(label, to, vehicles) {
  const oilTxt = (v) => v.oilLife != null ? ` — oil life remaining: ${Math.round(v.oilLife)}%` : "";
  const lines = vehicles.map((v) => {
    const over = v.overdueUnits > 0
      ? ` (${Math.round(v.overdueUnits).toLocaleString()} ${UNITS} past due)` : "";
    return `\u2022 ${v.name} — due at ${Math.round(v.intervalUnits).toLocaleString()} ${UNITS}, now at ${Math.round(v.currentUnits).toLocaleString()} ${UNITS}${over}${oilTxt(v)}`;
  });
  const body = [
    `The following vehicle(s) have reached their oil change interval.`,
    ``,
    ...lines,
    ``,
    `Auto-reset is turned OFF for oil reminders, so these counters have NOT`,
    `been reset. Each vehicle will keep showing as overdue until someone opens`,
    `the Add-In and clicks "Mark serviced now" on it.`,
    ``,
    `You will not get another email for these vehicles until they are confirmed.`,
    ``,
    `— Automated reminder from Dynasty Communications fleet monitoring`,
  ].join("\n");
  await deliver({
    to,
    subject: `Oil change overdue — confirmation needed: ${vehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  Awaiting-confirmation email sent to ${to} (${vehicles.length})`);
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
  await deliver({
    to,
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
  await deliver({
    to,
    subject: `Oil interval reached (auto-reset): ${vehicles.length} vehicle(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  DUE/auto-reset email sent to ${to} (${vehicles.length})`);
}

// Confirmation that a custom reminder was manually marked done in the Add-In.
async function sendCustomCompletedEmail(label, to, items) {
  const lines = items.map((c) => {
    const at = c.at ? ` at ${c.at}` : "";
    const next = c.interval ? ` — next due in ${Math.round(c.interval).toLocaleString()} ${c.unit}` : "";
    return `\u2022 ${c.device} — ${c.label} completed${at}${next}`;
  });
  const body = [
    `The following maintenance item(s) were marked done and their counters`,
    `were reset:`,
    ``,
    ...lines,
    ``,
    `— Automated confirmation from Dynasty Communications fleet monitoring`,
  ].join("\n");
  await deliver({
    to,
    subject: `Maintenance completed: ${items.length} reminder(s)${label ? " — " + label : ""}`,
    text: body,
  });
  console.log(`  Completion confirmation sent to ${to} (${items.length})`);
}

// Reads the custom-reminder AddInData, checks each against odometer (mi) or
// elapsed days, emails the ones that are due, and (unless auto-reset is turned
// off in Settings) resets their baseline.
// Returns { deviceId: { due:n, soon:n } } so the report can fold custom
// reminders into each asset's status.
async function processCustomReminders(client, account, label, odometerByDevice, globalDefaultEmail, autoResetCustom) {
  const records = await client.call("Get", {
    typeName: "AddInData",
    search: { addInId: CUSTOM_ADD_IN_ID },
  });

  if (globalDefaultEmail === undefined) globalDefaultEmail = null;
  if (autoResetCustom === undefined) autoResetCustom = true;

  const byDeviceStatus = {}; // deviceId -> { due, soon }
  function noteStatus(deviceId, key) {
    if (!byDeviceStatus[deviceId]) byDeviceStatus[deviceId] = { due: 0, soon: 0 };
    byDeviceStatus[deviceId][key]++;
  }

  // due reminders grouped by resolved recipient list
  const byRecipient = {}; // recipientString -> [ {label, device, at} ]
  // "Mark done" confirmations queued by the Add-In, same grouping
  const completedByRecipient = {}; // recipientString -> [ {label, device, at} ]

  for (const rec of records) {
    const d = typeof rec.details === "string" ? JSON.parse(rec.details) : rec.details;
    if (!d || d.settingsKey === "global" || !d.deviceId) continue;

    // ---- "Mark done" confirmation -------------------------------------
    // The Add-In sets emailPending when someone completes a reminder. That
    // also resets the baseline, so the due-check below will never catch it —
    // this block is the only thing that gets those emails out. Runs even when
    // the reminder is switched off, so the confirmation still lands.
    if (d.emailPending) {
      const recipient = (d.emailTo && d.emailTo.trim()) || globalDefaultEmail || account.emailTo || null;
      const key = recipient || "__none__";
      let doneAt = "";
      if (d.emailPendingOdoMeters != null) {
        doneAt = `${Math.round(d.emailPendingOdoMeters / METERS_PER_UNIT).toLocaleString()} ${UNITS}`;
      } else if (d.emailPendingDate) {
        doneAt = new Date(d.emailPendingDate).toLocaleDateString("en-US");
      }
      if (!completedByRecipient[key]) completedByRecipient[key] = [];
      completedByRecipient[key].push({
        label: d.label || "Reminder",
        device: d.deviceName || d.deviceId,
        at: doneAt,
        interval: d.interval,
        unit: d.type === "days" ? "days" : UNITS,
      });

      // Clear the flag so it only ever emails once. dueNotified goes too so the
      // reminder can notify again next cycle.
      delete d.emailPending;
      delete d.emailPendingReason;
      delete d.emailPendingOdoMeters;
      delete d.emailPendingDate;
      delete d.dueNotified;
      await client.call("Set", {
        typeName: "AddInData",
        entity: { id: rec.id, addInId: CUSTOM_ADD_IN_ID, groups: [{ id: "GroupCompanyId" }], details: d },
      });
    }

    if (d.enabled === false) continue;

    let isDue = false;
    let isSoon = false;
    let atText = "";
    if (d.type === "days") {
      const start = d.baselineDate ? new Date(d.baselineDate).getTime() : Date.now();
      const elapsedDays = (Date.now() - start) / 86400000;
      if (elapsedDays >= d.interval) { isDue = true; atText = `${Math.round(elapsedDays)} days elapsed`; }
      else if (elapsedDays >= d.interval * 0.85) isSoon = true;
    } else {
      const odo = odometerByDevice ? odometerByDevice[d.deviceId] : null;
      if (odo != null && d.baselineMeters != null) {
        const since = (odo - d.baselineMeters) / METERS_PER_UNIT;
        if (since >= d.interval) { isDue = true; atText = `${Math.round(odo / METERS_PER_UNIT).toLocaleString()} ${UNITS}`; }
        else if (since >= d.interval * 0.85) isSoon = true;
      }
    }

    if (isDue) noteStatus(d.deviceId, "due");
    else if (isSoon) noteStatus(d.deviceId, "soon");

    if (isDue) {
      // In manual mode a due reminder emails once and then sits there until
      // someone marks it done, so don't re-send on every run.
      if (!autoResetCustom && d.dueNotified) {
        console.log(`  ${d.deviceName || d.deviceId} / ${d.label}: still due, awaiting manual completion`);
        continue;
      }

      // resolve recipient: per-reminder override → global default → account default
      const recipient = (d.emailTo && d.emailTo.trim()) || globalDefaultEmail || account.emailTo || null;
      const key = recipient || "__none__";
      if (!byRecipient[key]) byRecipient[key] = [];
      byRecipient[key].push({
        label: d.label || "Reminder",
        device: d.deviceName || d.deviceId,
        at: atText,
        manual: !autoResetCustom,
      });

      const odo = odometerByDevice ? odometerByDevice[d.deviceId] : null;
      if (autoResetCustom) {
        // Auto mode: log the auto-completion and roll the baseline forward.
        if (!d.history) d.history = [];
        d.history.push({ date: new Date().toISOString(), odoMeters: d.type === "mi" ? odo : null, source: "auto" });
        if (d.type === "mi" && odo != null) d.baselineMeters = odo;
        d.baselineDate = new Date().toISOString();
      } else {
        // Manual mode: leave the baseline alone so it stays visibly due.
        d.dueNotified = true;
        d.dueNotifiedDate = new Date().toISOString();
      }
      const entity = { id: rec.id, addInId: CUSTOM_ADD_IN_ID, groups: [{ id: "GroupCompanyId" }], details: d };
      await client.call("Set", { typeName: "AddInData", entity });
    }
  }

  // ---- completion confirmations ("Mark done" in the Add-In) -----------
  const completedKeys = Object.keys(completedByRecipient);
  for (const key of completedKeys) {
    const items = completedByRecipient[key];
    if (key === "__none__") {
      console.log(`  ${items.length} completion confirmation(s) pending but no recipient resolved`);
      continue;
    }
    await sendCustomCompletedEmail(label, key, items);
  }

  const recipientKeys = Object.keys(byRecipient);
  if (!recipientKeys.length) { console.log(`  No custom reminders due.`); return byDeviceStatus; }

  for (const key of recipientKeys) {
    const items = byRecipient[key];
    if (key === "__none__") {
      console.log(`  ${items.length} custom reminder(s) due but no recipient resolved — skipping email`);
      continue;
    }
    const lines = items.map((c) => `\u2022 ${c.device} — ${c.label}${c.at ? " (" + c.at + ")" : ""}`);
    const footer = autoResetCustom
      ? [`Counters have been reset automatically.`]
      : [`Auto-reset is turned OFF for custom reminders, so these counters have`,
         `NOT been reset. Each will keep showing as due until someone opens the`,
         `Add-In and clicks "Mark done" on it. No further emails will be sent`,
         `for these until they are confirmed.`];
    const body = [
      `The following custom maintenance reminder(s) are due:`,
      ``,
      ...lines,
      ``,
      ...footer,
      ``,
      `— Automated reminder from Dynasty Communications fleet monitoring`,
    ].join("\n");
    // deliver() accepts comma-separated recipients directly
    await deliver({
      to: key,
      subject: `Maintenance due: ${items.length} custom reminder(s)${label ? " — " + label : ""}`,
      text: body,
    });
    console.log(`  Custom reminder email sent to ${key} (${items.length})`);
  }

  return byDeviceStatus;
}

// ---------------------------------------------------------------------------
// Minimal XLSX writer — zero dependencies.
// An .xlsx file is just a ZIP of XML parts. Node ships zlib, so we build the
// ZIP container by hand and avoid adding exceljs/sheetjs to the Actions job.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

// Builds a ZIP archive from [{name, data:Buffer}]
function zip(files) {
  const now = new Date();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const comp = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(dosTime(now), 10);
    local.writeUInt16LE(dosDate(now), 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime(now), 12);
    cd.writeUInt16LE(dosDate(now), 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function colName(n) { // 1 -> A
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * rows: array of arrays. Cell values may be string, number, null,
 *       or { v, style } where style is one of: header, num, text.
 * Returns a Buffer containing a valid .xlsx workbook.
 */
function buildWorkbook(sheetName, columns, rows) {
  // ---- styles: 0 default, 1 header, 2 integer w/ thousands, 3 wrapped text
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const cols = columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join("");

  const rowXml = rows.map((cells, ri) => {
    const r = ri + 1;
    const cellXml = cells.map((cell, ci) => {
      const ref = colName(ci + 1) + r;
      let v = cell, style = 0;
      if (cell && typeof cell === "object" && !Array.isArray(cell)) { v = cell.v; style = cell.s || 0; }
      if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${style}"/>`;
      if (typeof v === "number" && isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join("");
    return `<row r="${r}"${ri === 0 ? ' ht="20" customHeight="1"' : ""}>${cellXml}</row>`;
  }).join("");

  const lastCol = colName(columns.length);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastCol}${Math.max(rows.length, 1)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rowXml}</sheetData>
<autoFilter ref="A1:${lastCol}${Math.max(rows.length, 1)}"/>
</worksheet>`;

  const safeName = xmlEsc(String(sheetName || "Sheet1").slice(0, 31).replace(/[\\\/\?\*\[\]:]/g, "-"));

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(styles, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet, "utf8") },
  ];

  return zip(files);
}

// ---------------------------------------------------------------------------
// Scheduled fleet report (configured in the Add-In's Reporting tab)
// ---------------------------------------------------------------------------
// report = {
//   enabled, frequency: "daily"|"weekly", dayOfWeek: 0-6 (Sun=0),
//   time: "07:00", timezone: "America/New_York", recipients: "a@b.com,c@d.com",
//   assetMode: "all"|"groups"|"assets", groupIds: [], deviceIds: [],
//   testPending: bool, lastSentKey: "2026-08-13"
// }

// Wall-clock parts for a timezone, without pulling in a date library.
function zonedParts(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
    });
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    const hour = p.hour === "24" ? 0 : Number(p.hour);
    return {
      dateKey: `${p.year}-${p.month}-${p.day}`,
      minutes: hour * 60 + Number(p.minute),
      weekday: wd,
    };
  } catch (e) {
    // Unknown timezone (or no ICU) — fall back to the runner's clock.
    const d = date;
    return {
      dateKey: d.toISOString().slice(0, 10),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      weekday: d.getUTCDay(),
    };
  }
}

// Is the report due right now? Compares against the configured wall-clock time
// and a lastSentKey guard, so it fires on the first cron tick at or after the
// scheduled time and then not again that period — the cron can run as often as
// you like without double-sending.
function reportIsDue(report, now) {
  if (!report || !report.enabled) return { due: false, reason: "disabled" };
  const tz = report.timezone || "America/New_York";
  const { dateKey, minutes, weekday } = zonedParts(now, tz);

  const [hh, mm] = String(report.time || "07:00").split(":");
  const scheduled = (Number(hh) || 0) * 60 + (Number(mm) || 0);

  if (report.frequency === "weekly") {
    const target = Number(report.dayOfWeek);
    if (weekday !== (isNaN(target) ? 1 : target)) return { due: false, reason: "wrong weekday", dateKey };
  }
  if (minutes < scheduled) return { due: false, reason: "before scheduled time", dateKey };

  // Weekly uses the same date-key guard: once sent on its day, it can't repeat
  // until the next matching weekday, which is a different date key.
  if (report.lastSentKey === dateKey) return { due: false, reason: "already sent", dateKey };
  return { due: true, dateKey };
}

// Which assets belong in the report, per the Reporting tab's selection.
function selectReportDevices(devices, report) {
  if (!report || report.assetMode === "all" || !report.assetMode) return devices;
  if (report.assetMode === "assets") {
    const want = new Set(report.deviceIds || []);
    return devices.filter((d) => want.has(d.id));
  }
  if (report.assetMode === "groups") {
    const want = new Set(report.groupIds || []);
    return devices.filter((d) => (d.groups || []).some((g) => want.has(g.id)));
  }
  return devices;
}

// Folds custom-reminder state into the oil status so one Status column
// reflects everything outstanding on the asset.
function combinedStatus(row, custom) {
  const c = custom && custom[row.deviceId];
  const base = row.status;
  if (!c) return base;
  const extras = [];
  if (c.due) extras.push(`${c.due} custom due`);
  if (c.soon) extras.push(`${c.soon} custom due soon`);
  if (!extras.length) return base;
  if (base === "On track" && c.due) return `Due now (${extras.join(", ")})`;
  return `${base} (${extras.join(", ")})`;
}

function buildReportWorkbook(label, rows, custom, generatedAt) {
  const header = [
    { v: "Asset", s: 1 },
    { v: "Status", s: 1 },
    { v: `Mileage remaining before oil change (${UNITS})`, s: 1 },
    { v: `Odometer reading (${UNITS})`, s: 1 },
  ];
  const body = rows
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
    .map((r) => [
      { v: r.name, s: 3 },
      { v: combinedStatus(r, custom), s: 3 },
      r.remainingUnits == null
        ? { v: "\u2014", s: 3 }
        : { v: Math.round(r.remainingUnits), s: 2 },
      r.odoUnits == null
        ? { v: "\u2014", s: 3 }
        : { v: Math.round(r.odoUnits), s: 2 },
    ]);

  const columns = [{ width: 34 }, { width: 34 }, { width: 34 }, { width: 22 }];
  const sheetName = (label || "Fleet").slice(0, 24) + " report";
  return {
    buffer: buildWorkbook(sheetName, columns, [header, ...body]),
    count: body.length,
    generatedAt,
  };
}

async function maybeSendReport(client, account, label, settingsRec, reportRows, customStatus, devices) {
  const report = settingsRec.details.report;
  if (!report) return;

  const now = new Date();
  const check = reportIsDue(report, now);
  const isTest = !!report.testPending;

  if (!check.due && !isTest) {
    if (report.enabled) console.log(`  Report not due (${check.reason}).`);
    return;
  }

  const recipients =
    (report.recipients && report.recipients.trim()) ||
    (settingsRec.details.defaultEmailTo && settingsRec.details.defaultEmailTo.trim()) ||
    account.emailTo ||
    null;
  if (!recipients) {
    console.log(`  Report due but no recipients configured — skipping.`);
    return;
  }

  const selected = selectReportDevices(devices, report);
  const wanted = new Set(selected.map((d) => d.id));
  const rows = reportRows.filter((r) => wanted.has(r.deviceId));
  if (!rows.length) {
    console.log(`  Report due but no assets matched the selection — skipping.`);
    return;
  }

  const tz = report.timezone || "America/New_York";
  const stamp = zonedParts(now, tz).dateKey;
  const { buffer, count } = buildReportWorkbook(label, rows, customStatus, now);
  const fileLabel = String(label || "fleet").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
  const filename = `fleet-maintenance-${fileLabel}-${stamp}.xlsx`;

  const freqText = report.frequency === "weekly" ? "Weekly" : "Daily";
  const body = [
    `${isTest ? "Test" : freqText} fleet maintenance report${label ? " for " + label : ""}.`,
    ``,
    `${count} asset${count === 1 ? "" : "s"} included.`,
    `Generated ${now.toLocaleString("en-US", { timeZone: tz })} (${tz}).`,
    ``,
    `The attached spreadsheet lists each asset with its current service status,`,
    `mileage remaining before its next oil change, and odometer reading.`,
    ``,
    `— Automated report from Dynasty Communications fleet monitoring`,
  ].join("\n");

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: recipients,
    subject: `${isTest ? "[TEST] " : ""}Fleet maintenance report \u2014 ${stamp}${label ? " \u2014 " + label : ""}`,
    text: body,
    attachments: [{
      filename,
      content: buffer,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });
  console.log(`  Report emailed to ${recipients} (${count} assets, ${filename})`);

  // Record the send so we don't repeat this period, and consume the test flag.
  report.lastSentKey = check.dateKey || stamp;
  report.lastSentAt = now.toISOString();
  if (isTest) report.testPending = false;
  await saveGlobalSettings(client, settingsRec);
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
