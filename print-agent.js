/**
 * QuickPrint — print agent
 * -------------------------
 * Runs on the SHOP PC (the computer physically connected to the printer).
 * Polls the server every few seconds for paid-but-unprinted jobs,
 * downloads the file, sends it to the default printer, and reports back.
 *
 * SETUP (on the shop PC):
 *   npm init -y
 *   npm install axios pdf-to-printer
 *   (pdf-to-printer works on Windows. On Mac/Linux, replace printFile()
 *    with a call to `lp` via child_process — see note below.)
 *
 * Run:
 *   node print-agent.js
 *
 * Keep this running at all times (e.g. as a Windows service / pm2 process)
 * so jobs get printed as soon as customers pay.
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { print } = require('pdf-to-printer'); // Windows. See note below for Mac/Linux.

const API_BASE = process.env.API_BASE || 'https://your-backend-domain.example.com';
const POLL_INTERVAL_MS = 5000;
const DOWNLOAD_DIR = path.join(__dirname, 'print-queue');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

async function checkForJobs() {
  try {
    const { data } = await axios.get(`${API_BASE}/api/print-jobs/next`);
    if (!data.job) return;

    const job = data.job;
    console.log(`New job: ${job.id} (${job.original_name}) — ${job.copies} copies, ${job.color}`);

    // Download the file
    const localPath = path.join(DOWNLOAD_DIR, `${job.id}_${job.original_name}`);
    const fileRes = await axios.get(`${API_BASE}/api/print-jobs/${job.id}/file`, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(localPath);
      fileRes.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Send to printer
    try {
      await print(localPath, {
        copies: job.copies,
        // pdf-to-printer supports printer name, paper size, duplex options —
        // set these to match your shop printer, e.g.:
        // printer: "EPSON L3250",
        // orientation: "portrait",
      });
      await axios.post(`${API_BASE}/api/print-jobs/${job.id}/status`, { status: 'printed' });
      console.log(`Printed job ${job.id}`);
    } catch (printErr) {
      console.error(`Print failed for job ${job.id}:`, printErr.message);
      await axios.post(`${API_BASE}/api/print-jobs/${job.id}/status`, { status: 'failed' });
    }

  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

console.log(`Print agent started. Polling ${API_BASE} every ${POLL_INTERVAL_MS / 1000}s...`);
setInterval(checkForJobs, POLL_INTERVAL_MS);
checkForJobs();

/*
 * MAC / LINUX NOTE:
 * Replace the `print-to-printer` import and print() call with the built-in
 * `lp` command via Node's child_process, e.g.:
 *
 *   const { exec } = require('child_process');
 *   exec(`lp -n ${job.copies} "${localPath}"`, (err) => { ... });
 */
